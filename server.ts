// bb-plugin-office-files — backend entry running in the bb server process.
//
// The actual filesystem access happens in host.ts, a full-trust Node worker
// that bb runs ON the connected office-server machine. This file only picks
// which host to target, exposes RPC for app.tsx, and validates input.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { entrySchema, hostContract, readResultSchema, writeResultSchema } from "./contract.js";

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
    files_write: async ({ path: requestedPath, content }) => {
      const { rootPath } = await settings.get();
      const hostId = await resolveHostId();
      return host.call("writeFile", { rootPath, path: requestedPath, content }, { hostId });
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
