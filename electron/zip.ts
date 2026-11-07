// Потоковая упаковка папки в ZIP и безопасная распаковка — без загрузки файлов целиком в память.
// Формат: ZIP 2.0 (Deflate), имена в UTF-8 (флаг 11), размеры в дескрипторах данных (флаг 3).
// ZIP64 не нужен: архив ограничен лимитом вложения (50 МБ), исходные данные — MAX_FOLDER_BYTES.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { entryNameFromRelative, isInside, safeEntrySegments, uniqueName } from './zipPaths';

export const MAX_FOLDER_ENTRIES = 10000;
/** Исходный объём папки (до сжатия). Архив всё равно должен уложиться в лимит вложения. */
export const MAX_FOLDER_BYTES = 1024 * 1024 * 1024;
const MAX_UINT32 = 0xffffffff;

export interface FolderEntry {
  abs: string;
  rel: string;
  isDir: boolean;
  size: number;
  mtime: Date;
}

export interface FolderScan {
  entries: FolderEntry[];
  files: number;
  dirs: number;
  bytes: number;
  skippedLinks: number;
}

export class FolderLimitError extends Error {}

/**
 * Обход папки. Символические ссылки и точки соединения (junction) не открываются — иначе через них
 * можно было бы отправить файлы за пределами выбранной папки. Дополнительно каждая запись сверяется
 * с реальным путём корня.
 */
export async function scanFolder(root: string, signal?: AbortSignal): Promise<FolderScan> {
  const realRoot = await fs.promises.realpath(root);
  const out: FolderScan = { entries: [], files: 0, dirs: 0, bytes: 0, skippedLinks: 0 };
  const stack: string[] = [''];
  while (stack.length) {
    if (signal?.aborted) throw new Error('cancelled');
    const relDir = stack.pop()!;
    const absDir = path.join(realRoot, relDir);
    const dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
    for (const d of dirents) {
      const rel = relDir ? path.join(relDir, d.name) : d.name;
      const abs = path.join(realRoot, rel);
      const st = await fs.promises.lstat(abs);
      if (st.isSymbolicLink()) {
        out.skippedLinks++;
        continue;
      }
      if (!isInside(realRoot, abs)) continue;
      if (st.isDirectory()) {
        out.dirs++;
        out.entries.push({ abs, rel, isDir: true, size: 0, mtime: st.mtime });
        stack.push(rel);
      } else if (st.isFile()) {
        out.files++;
        out.bytes += st.size;
        out.entries.push({ abs, rel, isDir: false, size: st.size, mtime: st.mtime });
      }
      if (out.entries.length > MAX_FOLDER_ENTRIES) throw new FolderLimitError(`В папке больше ${MAX_FOLDER_ENTRIES} файлов и папок`);
      if (out.bytes > MAX_FOLDER_BYTES) throw new FolderLimitError('Папка больше 1 ГБ до сжатия');
    }
  }
  out.entries.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface CentralRecord {
  name: Buffer;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
  method: number;
  time: number;
  date: number;
  isDir: boolean;
}

export class ArchiveTooLargeError extends Error {}

/**
 * Упаковать папку в ZIP-файл out. Пишет потоково; прерывается, как только архив превышает maxBytes.
 * onProgress(упаковано файлов, всего файлов).
 */
export async function zipFolder(
  scan: FolderScan,
  out: string,
  maxBytes: number,
  onProgress: (packed: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ size: number }> {
  const fd = await fs.promises.open(out, 'w');
  let offset = 0;
  const central: CentralRecord[] = [];
  const write = async (buf: Buffer) => {
    if (offset + buf.length > maxBytes) throw new ArchiveTooLargeError('Папка после сжатия больше допустимого размера вложения');
    await fd.write(buf, 0, buf.length, offset);
    offset += buf.length;
  };
  let packed = 0;
  try {
    for (const e of scan.entries) {
      if (signal?.aborted) throw new Error('cancelled');
      const name = Buffer.from(entryNameFromRelative(e.rel, e.isDir), 'utf8');
      const { time, date } = dosDateTime(e.mtime);
      const method = e.isDir || e.size === 0 ? 0 : 8;
      const headerOffset = offset;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // версия для распаковки
      local.writeUInt16LE(0x0808, 6); // бит 3: дескриптор данных, бит 11: UTF-8
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      // crc, размеры = 0 — они в дескрипторе
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      await write(local);
      await write(name);

      let crc = 0;
      let csize = 0;
      let usize = 0;
      if (!e.isDir && e.size > 0) {
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            crc = zlib.crc32(chunk, crc);
            usize += chunk.length;
            cb(null, chunk);
          },
        });
        const sink = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            csize += chunk.length;
            write(chunk).then(() => cb(), cb);
          },
        });
        await pipeline(fs.createReadStream(e.abs), counter, zlib.createDeflateRaw({ level: 6 }), sink, { signal });
        if (usize > MAX_UINT32) throw new FolderLimitError('Файл в папке слишком большой');
      }
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc >>> 0, 4);
      desc.writeUInt32LE(csize, 8);
      desc.writeUInt32LE(usize, 12);
      await write(desc);
      central.push({ name, crc: crc >>> 0, csize, usize, offset: headerOffset, method, time, date, isDir: e.isDir });
      if (!e.isDir) onProgress(++packed, scan.files);
    }
    const cdStart = offset;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(0x0314, 4); // создано: UNIX-атрибуты, версия 2.0
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0808, 8);
      h.writeUInt16LE(c.method, 10);
      h.writeUInt16LE(c.time, 12);
      h.writeUInt16LE(c.date, 14);
      h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.csize, 20);
      h.writeUInt32LE(c.usize, 24);
      h.writeUInt16LE(c.name.length, 28);
      // внешние атрибуты: обычный файл 0644 / папка 0755 (+ флаг каталога MS-DOS); ссылок не бывает
      h.writeUInt32LE(c.isDir ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38);
      h.writeUInt32LE(c.offset, 42);
      await write(h);
      await write(c.name);
    }
    const cdSize = offset - cdStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    await write(end);
    return { size: offset };
  } finally {
    await fd.close();
  }
}

// ---------- Распаковка ----------

export interface ZipEntryInfo {
  name: string;
  segments: string[] | null;
  isDir: boolean;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  localOffset: number;
  flags: number;
}

export class UnsafeArchiveError extends Error {}

async function readAt(fd: fs.promises.FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fd.read(buf, 0, len, pos);
  if (bytesRead !== len) throw new UnsafeArchiveError('Архив повреждён');
  return buf;
}

export async function readZipIndex(file: string): Promise<ZipEntryInfo[]> {
  const fd = await fs.promises.open(file, 'r');
  try {
    const { size } = await fd.stat();
    const tailLen = Math.min(size, 22 + 65535);
    const tail = await readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new UnsafeArchiveError('Это не ZIP-архив');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count > MAX_FOLDER_ENTRIES + 1) throw new UnsafeArchiveError('В архиве слишком много файлов');
    if (cdOffset + cdSize > size) throw new UnsafeArchiveError('Архив повреждён');
    const cd = await readAt(fd, cdOffset, cdSize);
    const out: ZipEntryInfo[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new UnsafeArchiveError('Архив повреждён');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28);
      const xlen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      const localOffset = cd.readUInt32LE(p + 42);
      const nameBuf = cd.subarray(p + 46, p + 46 + nlen);
      const name = flags & 0x800 ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
      p += 46 + nlen + xlen + clen;
      const unixMode = external >>> 16;
      // Символические ссылки из архива не создаются
      if ((unixMode & 0o170000) === 0o120000) continue;
      if (flags & 0x1) throw new UnsafeArchiveError('Зашифрованные архивы не поддерживаются');
      if (method !== 0 && method !== 8) throw new UnsafeArchiveError('Неподдерживаемый метод сжатия');
      const isDir = name.endsWith('/') || name.endsWith('\\');
      out.push({ name, segments: safeEntrySegments(name), isDir, method, crc, csize, usize, localOffset, flags });
    }
    return out;
  } finally {
    await fd.close();
  }
}

export interface ExtractResult {
  folder: string;
  files: number;
  dirs: number;
  skipped: number;
}

/**
 * Распаковать архив папки в destParent/<имя папки>. Существующие файлы не перезаписываются:
 * если папка с таким именем есть, создаётся «Имя (2)». Каждая запись проверяется на выход за пределы.
 */
export async function extractZip(
  file: string,
  destParent: string,
  folderName: string,
  limits: { maxBytes: number },
  onProgress: (done: number, total: number) => void,
  markFile?: (p: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<ExtractResult> {
  const entries = await readZipIndex(file);
  const total = entries.reduce((a, e) => a + (e.isDir ? 0 : e.usize), 0);
  if (total > limits.maxBytes) throw new UnsafeArchiveError('Содержимое архива слишком большое');

  const parent = await fs.promises.realpath(destParent);
  const safeRoot = safeEntrySegments(folderName)?.join('_') || 'Папка';
  const rootName = uniqueName(safeRoot, (n) => fs.existsSync(path.join(parent, n)));
  const root = path.join(parent, rootName);
  await fs.promises.mkdir(root, { recursive: false });
  const realRoot = await fs.promises.realpath(root);

  const fd = await fs.promises.open(file, 'r');
  let done = 0;
  let files = 0;
  let dirs = 0;
  let skipped = 0;
  try {
    for (const e of entries) {
      if (signal?.aborted) throw new Error('cancelled');
      if (!e.segments) {
        skipped++;
        continue;
      }
      const target = path.join(root, ...e.segments);
      if (!isInside(root, target)) {
        skipped++;
        continue;
      }
      if (e.isDir) {
        await fs.promises.mkdir(target, { recursive: true });
        dirs++;
        continue;
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      // Родительские папки не должны оказаться ссылками (защита от подмены во время распаковки)
      const realDir = await fs.promises.realpath(path.dirname(target));
      if (realDir.toLowerCase() !== realRoot.toLowerCase() && !isInside(realRoot, realDir)) {
        skipped++;
        continue;
      }
      if (fs.existsSync(target)) {
        skipped++;
        continue;
      }
      const lh = await readAt(fd, e.localOffset, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new UnsafeArchiveError('Архив повреждён');
      const dataStart = e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      let crc = 0;
      let written = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length;
          // Защита от «zip-бомб»: распакованных данных не может быть больше заявленного
          if (written > e.usize) return cb(new UnsafeArchiveError('Размер файла в архиве не совпадает'));
          crc = zlib.crc32(chunk, crc);
          done += chunk.length;
          onProgress(done, total);
          cb(null, chunk);
        },
      });
      const src = e.csize > 0 ? fs.createReadStream(file, { start: dataStart, end: dataStart + e.csize - 1 }) : null;
      const outStream = fs.createWriteStream(target, { flags: 'wx' });
      if (src) {
        if (e.method === 8) await pipeline(src, zlib.createInflateRaw(), guard, outStream, { signal });
        else await pipeline(src, guard, outStream, { signal });
      } else {
        await new Promise<void>((res, rej) => outStream.end((err?: Error | null) => (err ? rej(err) : res())));
      }
      if (written !== e.usize || (crc >>> 0) !== e.crc) {
        await fs.promises.rm(target, { force: true });
        throw new UnsafeArchiveError(`Файл «${e.segments.join('/')}» повреждён`);
      }
      await markFile?.(target);
      files++;
    }
  } finally {
    await fd.close();
  }
  return { folder: root, files, dirs, skipped };
}
