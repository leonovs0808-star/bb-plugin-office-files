// Full-trust host entry: runs as a Node 22 ESM worker on the connected
// office-server machine (not on the bb backend machine), so it is the only
// place in this plugin with real fs access to /home/aikomanda/neuroshtab.
// BB's own bb.sdk.files/bb.sdk.hosts.directory helpers silently skip
// dotfiles (.claude, .agents, ...) — the office explicitly wants those
// visible, so this plugin reads the filesystem itself instead.
import {
  open as fsOpen,
  realpath,
  readdir,
  readFile as fsReadFile,
  stat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import path from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  hostContract,
  type ChunkResult,
  type Entry,
  type FileMeta,
  type ReadResult,
  type WriteResult,
} from "./contract.js";

const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 2 MB text preview cap
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB inline image cap
const BINARY_SNIFF_BYTES = 8192;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

/** Resolves `target` and confirms it stays inside `rootPath` (both absolute). */
async function resolveWithin(rootPath: string, target: string): Promise<string> {
  if (!path.isAbsolute(rootPath) || !path.isAbsolute(target)) {
    throw new Error("Paths must be absolute");
  }
  const root = await realpath(rootPath);
  const real = await realpath(target);
  const relative = path.relative(root, real);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return real;
  }
  throw new Error(`Path "${target}" is outside the office root`);
}

async function listDir(rootPath: string, requestedPath: string) {
  const dir = await resolveWithin(rootPath, requestedPath);
  const stats = await stat(dir);
  if (!stats.isDirectory()) throw new Error(`"${dir}" is not a directory`);
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries: Entry[] = [];
  for (const dirent of dirents) {
    const entryPath = path.join(dir, dirent.name);
    let kind: "directory" | "file";
    let sizeBytes: number | null = null;
    let modifiedAtMs: number | null = null;
    try {
      const entryStat = await stat(entryPath);
      kind = entryStat.isDirectory() ? "directory" : "file";
      sizeBytes = entryStat.isDirectory() ? null : entryStat.size;
      modifiedAtMs = entryStat.mtimeMs;
    } catch {
      continue; // broken symlink or a race with deletion — skip it
    }
    entries.push({ name: dirent.name, path: entryPath, kind, sizeBytes, modifiedAtMs });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, "ru");
  });
  const parentDir = path.dirname(dir);
  const relativeToRoot = path.relative(rootPath, dir);
  const parent = relativeToRoot === "" ? null : parentDir;
  return { path: dir, parent, entries };
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, BINARY_SNIFF_BYTES);
  return sample.includes(0);
}

async function readFile(rootPath: string, requestedPath: string): Promise<ReadResult> {
  const file = await resolveWithin(rootPath, requestedPath);
  const fileStat = await stat(file);
  const imageMime = IMAGE_MIME_BY_EXT[path.extname(file).toLowerCase()];
  if (imageMime !== undefined) {
    if (fileStat.size > MAX_IMAGE_BYTES) {
      return { kind: "too-large", sizeBytes: fileStat.size };
    }
    const buffer = await fsReadFile(file);
    return {
      kind: "image",
      mimeType: imageMime,
      base64: buffer.toString("base64"),
      sizeBytes: fileStat.size,
    };
  }
  if (fileStat.size > MAX_TEXT_BYTES) {
    return { kind: "too-large", sizeBytes: fileStat.size };
  }
  const buffer = await fsReadFile(file);
  if (looksBinary(buffer)) {
    return { kind: "binary", sizeBytes: fileStat.size };
  }
  return { kind: "text", content: buffer.toString("utf8"), sizeBytes: fileStat.size };
}

async function writeFile(
  rootPath: string,
  requestedPath: string,
  content: string,
): Promise<WriteResult> {
  const file = await resolveWithin(rootPath, requestedPath);
  await fsWriteFile(file, content, "utf8");
  const fileStat = await stat(file);
  return { ok: true, sizeBytes: fileStat.size };
}

/** Name/size for a download, without reading any bytes — works for any size. */
async function statFile(rootPath: string, requestedPath: string): Promise<FileMeta> {
  const file = await resolveWithin(rootPath, requestedPath);
  const fileStat = await stat(file);
  if (fileStat.isDirectory()) throw new Error(`"${file}" is a directory, not a file`);
  return {
    name: path.basename(file),
    sizeBytes: fileStat.size,
    modifiedAtMs: fileStat.mtimeMs,
  };
}

/** One slice of a file as base64 — the download route walks the file with these. */
async function readChunk(
  rootPath: string,
  requestedPath: string,
  offset: number,
  length: number,
): Promise<ChunkResult> {
  const file = await resolveWithin(rootPath, requestedPath);
  const handle = await fsOpen(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return { base64: buffer.subarray(0, bytesRead).toString("base64"), bytesRead };
  } finally {
    await handle.close();
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    listDir: ({ rootPath, path: requestedPath }) => listDir(rootPath, requestedPath),
    readFile: ({ rootPath, path: requestedPath }) => readFile(rootPath, requestedPath),
    writeFile: ({ rootPath, path: requestedPath, content }) =>
      writeFile(rootPath, requestedPath, content),
    statFile: ({ rootPath, path: requestedPath }) => statFile(rootPath, requestedPath),
    readChunk: ({ rootPath, path: requestedPath, offset, length }) =>
      readChunk(rootPath, requestedPath, offset, length),
  },
});
