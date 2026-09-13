// Shared shapes between server.ts (runs in the bb backend) and host.ts (runs
// full-trust on the connected office-server machine). Both sides import this
// file; neither imports the other.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const entrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["directory", "file"]),
  sizeBytes: z.number().nullable(),
  modifiedAtMs: z.number().nullable(),
});
export type Entry = z.infer<typeof entrySchema>;

export const readResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), content: z.string(), sizeBytes: z.number() }),
  z.object({
    kind: z.literal("image"),
    mimeType: z.string(),
    base64: z.string(),
    sizeBytes: z.number(),
  }),
  z.object({ kind: z.literal("binary"), sizeBytes: z.number() }),
  z.object({ kind: z.literal("too-large"), sizeBytes: z.number() }),
]);
export type ReadResult = z.infer<typeof readResultSchema>;

export const writeResultSchema = z.object({ ok: z.literal(true), sizeBytes: z.number() });
export type WriteResult = z.infer<typeof writeResultSchema>;

/** One download read is capped so a single RPC payload stays small (base64 inflates ~4/3). */
export const MAX_DOWNLOAD_CHUNK_BYTES = 2 * 1024 * 1024;

export const fileMetaSchema = z.object({
  name: z.string(),
  sizeBytes: z.number(),
  modifiedAtMs: z.number(),
});
export type FileMeta = z.infer<typeof fileMetaSchema>;

export const chunkResultSchema = z.object({ base64: z.string(), bytesRead: z.number() });
export type ChunkResult = z.infer<typeof chunkResultSchema>;

/** Search stops at this many hits so one broad query cannot walk the whole office twice. */
export const MAX_SEARCH_MATCHES = 300;

export const searchResultSchema = z.object({
  matches: z.array(entrySchema),
  truncated: z.boolean(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

/** Runtime contract for the host.ts entry (full fs access on the office server). */
export const hostContract = defineRpcContract({
  listDir: {
    input: z.object({ rootPath: z.string(), path: z.string() }),
    output: z.object({
      path: z.string(),
      parent: z.string().nullable(),
      entries: z.array(entrySchema),
    }),
  },
  readFile: {
    input: z.object({ rootPath: z.string(), path: z.string() }),
    output: readResultSchema,
  },
  writeFile: {
    input: z.object({ rootPath: z.string(), path: z.string(), content: z.string() }),
    output: writeResultSchema,
  },
  // Download path: stat once for the name/size, then pull the bytes chunk by
  // chunk so a 200 MB video never has to fit in one RPC payload.
  statFile: {
    input: z.object({ rootPath: z.string(), path: z.string() }),
    output: fileMetaSchema,
  },
  readChunk: {
    input: z.object({
      rootPath: z.string(),
      path: z.string(),
      offset: z.number().int().nonnegative(),
      length: z.number().int().positive().max(MAX_DOWNLOAD_CHUNK_BYTES),
    }),
    output: chunkResultSchema,
  },
  searchFiles: {
    input: z.object({
      rootPath: z.string(),
      query: z.string().min(1),
      limit: z.number().int().positive().max(MAX_SEARCH_MATCHES),
    }),
    output: searchResultSchema,
  },
});
