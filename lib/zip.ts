// Сборка zip-архива папки без внешних зависимостей: только node:zlib и потоки.
//
// Почему свой писатель, а не `zip`/`tar` через child_process: host.ts крутится на
// машине офиса, какой она будет — неизвестно (у нас на сервере `zip` не стоит
// вовсе, только `tar`). Node есть по определению — значит архив умеет собрать
// сам плагин, одинаково на любой машине.
//
// Формат — обычный zip32 с data descriptor (флаг bit 3): размеры и CRC файла
// становятся известны только ПОСЛЕ сжатия, а так их можно дописать следом за
// данными и не держать файл в памяти целиком. Имена — UTF-8 (флаг bit 11).
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createDeflateRaw } from "node:zlib";

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8_NAMES = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** Потолок zip32: смещения и размеры в заголовках — 32-битные. */
const ZIP32_LIMIT = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer, previous: number): number {
  let crc = ~previous >>> 0;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ buffer[index]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return ~crc >>> 0;
}

/** Время модификации в формате MS-DOS — то, что zip хранит вместо unix-времени. */
function dosDateTime(modifiedAtMs: number): { time: number; date: number } {
  const when = new Date(modifiedAtMs);
  const year = when.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 }; // 01.01.1980
  const time =
    (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  return { time, date };
}

type PlannedEntry = {
  absolutePath: string;
  /** Путь внутри архива, всегда через `/` — так требует формат. */
  archiveName: string;
  kind: "directory" | "file";
  modifiedAtMs: number;
  sizeBytes: number;
};

export type ZipResult = {
  sizeBytes: number;
  fileCount: number;
  /** Симлинки, нечитаемые и исчезнувшие по дороге записи — молча не теряем, считаем. */
  skippedCount: number;
};

/**
 * Обход папки в глубину. Симлинки не разворачиваются (иначе архив может выйти
 * за корень офиса и зациклиться), пустые папки сохраняются отдельной записью —
 * иначе распаковка потеряет структуру.
 */
async function planEntries(
  sourceDir: string,
  maxFiles: number,
  maxTotalBytes: number,
): Promise<{ entries: PlannedEntry[]; skippedCount: number }> {
  const rootName = path.basename(sourceDir);
  const entries: PlannedEntry[] = [];
  let skippedCount = 0;
  let totalBytes = 0;

  async function walk(currentDir: string, prefix: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(currentDir, { withFileTypes: true });
    } catch {
      skippedCount += 1;
      return;
    }
    if (dirents.length === 0 && prefix !== `${rootName}/`) {
      entries.push({
        absolutePath: currentDir,
        archiveName: prefix,
        kind: "directory",
        modifiedAtMs: Date.now(),
        sizeBytes: 0,
      });
      return;
    }
    for (const dirent of dirents) {
      const absolutePath = path.join(currentDir, dirent.name);
      if (dirent.isSymbolicLink()) {
        skippedCount += 1;
        continue;
      }
      if (dirent.isDirectory()) {
        await walk(absolutePath, `${prefix}${dirent.name}/`);
        continue;
      }
      if (!dirent.isFile()) {
        skippedCount += 1; // сокет, fifo, устройство — в архиве им делать нечего
        continue;
      }
      let fileStat;
      try {
        fileStat = await stat(absolutePath);
      } catch {
        skippedCount += 1; // файл исчез между readdir и stat
        continue;
      }
      if (entries.length >= maxFiles) {
        throw new Error(
          `В папке больше ${maxFiles.toLocaleString("ru")} файлов — архив такого размера ` +
            `панель не собирает. Скачай нужную подпапку отдельно.`,
        );
      }
      totalBytes += fileStat.size;
      if (totalBytes > maxTotalBytes) {
        throw new Error(
          "Папка весит больше 4 ГБ — формат zip столько не держит. " +
            "Скачай нужную подпапку отдельно.",
        );
      }
      entries.push({
        absolutePath,
        archiveName: `${prefix}${dirent.name}`,
        kind: "file",
        modifiedAtMs: fileStat.mtimeMs,
        sizeBytes: fileStat.size,
      });
    }
  }

  await walk(sourceDir, `${rootName}/`);
  return { entries, skippedCount };
}

/** Запись в поток с ожиданием drain — иначе большой архив упрётся в буфер. */
function writeChunk(out: WriteStream, buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    out.write(buffer, (error) => (error ? reject(error) : resolve()));
  });
}

function localHeader(entry: PlannedEntry, nameBytes: Buffer): Buffer {
  const { time, date } = dosDateTime(entry.modifiedAtMs);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(20, 4); // минимальная версия распаковщика — 2.0
  header.writeUInt16LE(
    entry.kind === "file" ? FLAG_DATA_DESCRIPTOR | FLAG_UTF8_NAMES : FLAG_UTF8_NAMES,
    6,
  );
  header.writeUInt16LE(entry.kind === "file" ? METHOD_DEFLATE : METHOD_STORE, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  // CRC и размеры у файла уезжают в data descriptor, у папки они нулевые.
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28); // extra field
  return header;
}

function centralHeader(
  entry: PlannedEntry,
  nameBytes: Buffer,
  crc: number,
  compressedSize: number,
  rawSize: number,
  localOffset: number,
): Buffer {
  const { time, date } = dosDateTime(entry.modifiedAtMs);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(20, 4); // version made by
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(
    entry.kind === "file" ? FLAG_DATA_DESCRIPTOR | FLAG_UTF8_NAMES : FLAG_UTF8_NAMES,
    8,
  );
  header.writeUInt16LE(entry.kind === "file" ? METHOD_DEFLATE : METHOD_STORE, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(crc >>> 0, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(rawSize, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30); // extra
  header.writeUInt16LE(0, 32); // comment
  header.writeUInt16LE(0, 34); // disk number
  header.writeUInt16LE(0, 36); // internal attrs
  // Внешние атрибуты: права 0755/0644 в старших битах + DOS-бит папки.
  const unixMode = entry.kind === "directory" ? 0o40755 : 0o100644;
  const dosDirectoryBit = entry.kind === "directory" ? 0x10 : 0;
  // `>>> 0` в конце обязателен: без него OR возвращает знаковое число и
  // writeUInt32LE падает на правах вида 0o100644 (старший бит выставлен).
  header.writeUInt32LE((((unixMode << 16) >>> 0) | dosDirectoryBit) >>> 0, 38);
  header.writeUInt32LE(localOffset, 42);
  return header;
}

/**
 * Пакует `sourceDir` в `archivePath`. Данные идут файл за файлом через
 * deflate-поток, поэтому в памяти одновременно живёт только один буфер потока —
 * папка с видео на несколько гигабайт пакуется так же, как папка с заметками.
 */
export async function writeZip(options: {
  sourceDir: string;
  archivePath: string;
  maxFiles: number;
  maxTotalBytes: number;
}): Promise<ZipResult> {
  const { entries, skippedCount } = await planEntries(
    options.sourceDir,
    options.maxFiles,
    options.maxTotalBytes,
  );

  const out = createWriteStream(options.archivePath);
  const central: Buffer[] = [];
  let offset = 0;
  let fileCount = 0;

  try {
    for (const entry of entries) {
      const nameBytes = Buffer.from(entry.archiveName, "utf8");
      const localOffset = offset;
      if (localOffset > ZIP32_LIMIT) {
        throw new Error("Архив перевалил за 4 ГБ — скачай папку по частям.");
      }
      await writeChunk(out, localHeader(entry, nameBytes));
      await writeChunk(out, nameBytes);
      offset += 30 + nameBytes.length;

      let crc = 0;
      let rawSize = 0;
      let compressedSize = 0;

      if (entry.kind === "file") {
        const countRaw = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            crc = crc32(chunk, crc);
            rawSize += chunk.length;
            callback(null, chunk);
          },
        });
        const countCompressed = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            compressedSize += chunk.length;
            callback(null, chunk);
          },
        });
        try {
          await pipeline(
            createReadStream(entry.absolutePath),
            countRaw,
            createDeflateRaw({ level: 6 }),
            countCompressed,
            out,
            { end: false },
          );
        } catch {
          // Файл исчез или стал нечитаемым прямо во время упаковки. Ломать
          // весь архив из-за одной записи нельзя — дописываем её пустой.
          crc = 0;
          rawSize = 0;
          compressedSize = 0;
        }
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
        descriptor.writeUInt32LE(crc >>> 0, 4);
        descriptor.writeUInt32LE(compressedSize, 8);
        descriptor.writeUInt32LE(rawSize, 12);
        await writeChunk(out, descriptor);
        offset += compressedSize + 16;
        fileCount += 1;
      }

      central.push(
        centralHeader(entry, nameBytes, crc, compressedSize, rawSize, localOffset),
        nameBytes,
      );
    }

    if (entries.length > 0xffff) {
      throw new Error("В папке слишком много записей для zip — скачай её по частям.");
    }

    const centralOffset = offset;
    for (const buffer of central) {
      await writeChunk(out, buffer);
      offset += buffer.length;
    }
    const centralSize = offset - centralOffset;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
    eocd.writeUInt16LE(0, 4); // номер диска
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    eocd.writeUInt16LE(0, 20); // комментарий архива
    await writeChunk(out, eocd);
    offset += 22;
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.once("error", reject);
      out.end(() => resolve());
    });
  }

  return { sizeBytes: offset, fileCount, skippedCount };
}
