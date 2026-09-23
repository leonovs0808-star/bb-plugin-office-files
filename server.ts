// bb-plugin-office-files — backend entry running in the bb server process.
//
// The actual filesystem access happens in host.ts, a full-trust Node worker
// that bb runs ON the connected office-server machine. This file only picks
// which host to target, exposes RPC for app.tsx, and validates input.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  MAX_DOWNLOAD_CHUNK_BYTES,
  MAX_SEARCH_MATCHES,
  entrySchema,
  hostContract,
  readResultSchema,
  searchResultSchema,
  writeResultSchema,
} from "./contract.js";

/** RFC 5987 content-disposition: ASCII fallback plus the real UTF-8 name. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export const rpcContract = defineRpcContract({
  files_list: {
    input: z.object({ path: z.string().optional() }),
    output: z.object({
      rootPath: z.string(),
      path: z.string(),
      parent: z.string().nullable(),
      entries: z.array(entrySchema),
    }),
  },
  files_read: {
    input: z.object({ path: z.string() }),
    output: readResultSchema,
  },
  files_write: {
    input: z.object({ path: z.string(), content: z.string() }),
    output: writeResultSchema,
  },
  files_search: {
    input: z.object({ query: z.string() }),
    output: searchResultSchema,
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    rootPath: {
      type: "string",
      label: "Корень офиса",
      default: "/home/aikomanda/neuroshtab",
    },
    // Auto-picks the connected machine whose name/id contains this text
    // (case-insensitive) — set hostId below instead for an exact pin.
    hostMatch: {
      type: "string",
      label: "Подстрока имени машины офиса",
      default: "fastvps",
    },
    hostId: {
      type: "string",
      label: "ID машины офиса (необязательно, точный выбор)",
      default: "",
    },
  });

  const host = bb.hosts.experimental_client({ contract: hostContract });

  async function resolveHostId(): Promise<string> {
    const { hostId, hostMatch } = await settings.get();
    if (hostId.trim() !== "") return hostId.trim();
    const hosts = await bb.sdk.hosts.list();
    const connected = hosts.filter((candidate) => candidate.status === "connected");
    const needle = hostMatch.trim().toLowerCase();
    const byName = needle === ""
      ? undefined
      : connected.find(
          (candidate) =>
            candidate.name.toLowerCase().includes(needle) ||
            candidate.id.toLowerCase().includes(needle),
        );
    const chosen = byName ?? connected[0];
    if (chosen === undefined) {
      throw new Error(
        "Не нашёл подключённую машину офиса. Укажи её ID в настройках плагина (hostId).",
      );
    }
    return chosen.id;
  }

  bb.rpc.register(rpcContract, {
    files_list: async ({ path: requestedPath }) => {
      const { rootPath } = await settings.get();
      const hostId = await resolveHostId();
      const result = await host.call(
        "listDir",
        { rootPath, path: requestedPath ?? rootPath },
        { hostId },
      );
      return { rootPath, ...result };
    },
    files_read: async ({ path: requestedPath }) => {
      const { rootPath } = await settings.get();
      const hostId = await resolveHostId();
      return host.call("readFile", { rootPath, path: requestedPath }, { hostId });
    },
    files_search: async ({ query }) => {
      if (query.trim() === "") return { matches: [], truncated: false };
      const { rootPath } = await settings.get();
      const hostId = await resolveHostId();
      return host.call(
        "searchFiles",
        { rootPath, query, limit: MAX_SEARCH_MATCHES },
        { hostId },
      );
    },
    files_write: async ({ path: requestedPath, content }) => {
      const { rootPath } = await settings.get();
      const hostId = await resolveHostId();
      return host.call("writeFile", { rootPath, path: requestedPath, content }, { hostId });
    },
  });

  // Download: a plain GET the browser can stream to disk. The bytes live on the
  // office machine, so the route pulls them from host.ts chunk by chunk and
  // pipes them straight through — nothing is buffered whole on either side,
  // which is what makes big files (video, archives) work at all.
  bb.http.route("GET", "/download", async (context) => {
    const requestedPath = context.req.query("path");
    if (requestedPath === undefined || requestedPath.trim() === "") {
      return new Response("Нужен параметр ?path=", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const { rootPath } = await settings.get();
    let hostId: string;
    let meta: { name: string; sizeBytes: number; modifiedAtMs: number };
    try {
      hostId = await resolveHostId();
      meta = await host.call("statFile", { rootPath, path: requestedPath }, { hostId });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      bb.log.info(`download rejected: ${message}`);
      return new Response(message, {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const total = meta.sizeBytes;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (offset >= total) {
          controller.close();
          return;
        }
        try {
          const length = Math.min(MAX_DOWNLOAD_CHUNK_BYTES, total - offset);
          const chunk = await host.call(
            "readChunk",
            { rootPath, path: requestedPath, offset, length },
            { hostId },
          );
          if (chunk.bytesRead === 0) {
            controller.close(); // file shrank mid-transfer — stop instead of looping
            return;
          }
          controller.enqueue(new Uint8Array(Buffer.from(chunk.base64, "base64")));
          offset += chunk.bytesRead;
        } catch (cause) {
          controller.error(cause instanceof Error ? cause : new Error(String(cause)));
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(total),
        "content-disposition": contentDisposition(meta.name),
        "cache-control": "no-store",
      },
    });
  });

  // Скачивание папки: она сначала пакуется в zip на машине офиса (host.ts), и уже
  // готовый архив течёт в браузер теми же кусками, что и обычный файл. Пакуем
  // именно там, где лежат файлы, — тянуть тысячу файлов по одному через RPC,
  // чтобы сжать их на стороне bb, было бы на порядок дольше.
  bb.http.route("GET", "/download-folder", async (context) => {
    const requestedPath = context.req.query("path");
    if (requestedPath === undefined || requestedPath.trim() === "") {
      return new Response("Нужен параметр ?path=", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const { rootPath } = await settings.get();
    let hostId: string;
    let archive: { token: string; name: string; sizeBytes: number; fileCount: number };
    try {
      hostId = await resolveHostId();
      archive = await host.call("packDirectory", { rootPath, path: requestedPath }, { hostId });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      bb.log.info(`folder download rejected: ${message}`);
      return new Response(message, {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    bb.log.info(
      `folder download: ${requestedPath} → ${archive.name} ` +
        `(${archive.fileCount} файлов, ${archive.sizeBytes} Б)`,
    );

    const total = archive.sizeBytes;
    let offset = 0;
    /** Архив временный: убираем его и когда дочитали, и когда вкладку закрыли на середине. */
    const discard = async () => {
      try {
        await host.call("discardArchive", { token: archive.token }, { hostId });
      } catch (cause) {
        bb.log.info(`archive cleanup failed: ${cause instanceof Error ? cause.message : cause}`);
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (offset >= total) {
          controller.close();
          await discard();
          return;
        }
        try {
          const length = Math.min(MAX_DOWNLOAD_CHUNK_BYTES, total - offset);
          const chunk = await host.call(
            "readArchiveChunk",
            { token: archive.token, offset, length },
            { hostId },
          );
          if (chunk.bytesRead === 0) {
            controller.close();
            await discard();
            return;
          }
          controller.enqueue(new Uint8Array(Buffer.from(chunk.base64, "base64")));
          offset += chunk.bytesRead;
        } catch (cause) {
          controller.error(cause instanceof Error ? cause : new Error(String(cause)));
          await discard();
        }
      },
      async cancel() {
        await discard();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(total),
        "content-disposition": contentDisposition(archive.name),
        "cache-control": "no-store",
      },
    });
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
