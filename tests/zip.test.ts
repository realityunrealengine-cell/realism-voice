// Упаковка папки в ZIP и распаковка: структура, пустые папки, длинные пути, ссылки, zip-slip, zip-бомбы, лимит.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ArchiveTooLargeError, extractZip, readZipIndex, scanFolder, zipFolder } from '../electron/zip';
import { isInside, safeEntrySegments, sanitizeSegment, uniqueName } from '../electron/zipPaths';
import { isDangerousFile } from '../electron/fileRisk';

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-zip-test-'));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        out.push(`${r}/`);
        walk(r);
      } else out.push(`${r} ${fs.statSync(path.join(root, r)).size}`);
    }
  };
  walk('');
  return out.sort();
}

/** Простой ZIP с произвольными именами записей (для атак) */
function craftZip(entries: { name: string; data: Buffer; declaredSize?: number }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const comp = zlib.deflateRawSync(e.data);
    const crc = zlib.crc32(e.data) >>> 0;
    const usize = e.declaredSize ?? e.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    parts.push(lh, name, comp);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

describe('пути внутри архива', () => {
  it('отклоняет выход за пределы папки', () => {
    for (const bad of ['../evil.txt', 'a/../../evil', '/etc/passwd', 'C:\\Windows\\x.dll', 'c:evil', '\\\\server\\share\\x', 'a/b:stream', '..', '']) {
      expect(safeEntrySegments(bad), bad).toBeNull();
    }
  });
  it('сохраняет обычные и вложенные имена, чистит запрещённые символы Windows', () => {
    expect(safeEntrySegments('Проект/src/main.ts')).toEqual(['Проект', 'src', 'main.ts']);
    expect(safeEntrySegments('a\\b\\c.txt')).toEqual(['a', 'b', 'c.txt']);
    expect(safeEntrySegments('dir/what?.txt')).toEqual(['dir', 'what_.txt']);
    expect(sanitizeSegment('CON')).toBe('_CON');
    expect(sanitizeSegment('nul.txt')).toBe('_nul.txt');
    expect(sanitizeSegment('name. ')).toBe('name');
    expect(sanitizeSegment('x'.repeat(300) + '.txt').length).toBeLessThanOrEqual(200);
  });
  it('isInside и уникальные имена', () => {
    expect(isInside('C:\\a\\b', 'C:\\a\\b\\c')).toBe(true);
    expect(isInside('C:\\a\\b', 'C:\\a\\bc\\d')).toBe(false);
    expect(isInside('C:\\a\\b', 'C:\\a\\B\\c')).toBe(true);
    expect(uniqueName('Папка', (n) => ['Папка', 'Папка (2)'].includes(n))).toBe('Папка (3)');
  });
  it('опасные типы файлов', () => {
    for (const n of ['setup.exe', 'a.BAT', 'x.ps1', 'doc.pdf.lnk', 'macro.xlsm', 'app.msi']) expect(isDangerousFile(n), n).toBe(true);
    for (const n of ['photo.png', 'notes.txt', 'archive.zip', 'video.mkv', 'readme']) expect(isDangerousFile(n), n).toBe(false);
  });
});

describe('папка → ZIP → папка', () => {
  it('сохраняет структуру, пустые папки, имена и содержимое; ссылки не выходят за пределы', async () => {
    const src = path.join(tmp, 'Мой проект');
    fs.mkdirSync(path.join(src, 'src', 'deep', 'deeper'), { recursive: true });
    fs.mkdirSync(path.join(src, 'empty dir'));
    fs.writeFileSync(path.join(src, 'README.md'), '# Привет');
    fs.writeFileSync(path.join(src, 'src', 'main.ts'), 'console.log(1)\n'.repeat(1000));
    fs.writeFileSync(path.join(src, 'src', 'deep', 'deeper', 'empty.txt'), '');
    const big = Buffer.alloc(300_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7919) % 251;
    fs.writeFileSync(path.join(src, 'data.bin'), big);
    // Длинный путь (> 260 символов)
    let longDir = path.join(src, 'long');
    while (longDir.length < 300) longDir = path.join(longDir, 'очень-длинное-имя-папки');
    fs.mkdirSync(longDir, { recursive: true });
    fs.writeFileSync(path.join(longDir, 'file.txt'), 'long');
    // Ссылка (junction) на папку вне выбранной — не должна попасть в архив
    const outside = path.join(tmp, 'secret');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'password.txt'), 'secret');
    let linkCreated = true;
    try {
      fs.symlinkSync(outside, path.join(src, 'link-to-secret'), 'junction');
    } catch {
      linkCreated = false;
    }

    const scan = await scanFolder(src);
    if (linkCreated) expect(scan.skippedLinks).toBe(1);
    expect(scan.entries.some((e) => e.rel.includes('password'))).toBe(false);

    const zipPath = path.join(tmp, 'out.zip');
    let progressCalls = 0;
    const { size } = await zipFolder(scan, zipPath, 50 * 1024 * 1024, () => progressCalls++);
    expect(size).toBe(fs.statSync(zipPath).size);
    expect(progressCalls).toBe(scan.files);

    const dest = path.join(tmp, 'dest');
    fs.mkdirSync(dest);
    const res = await extractZip(zipPath, dest, 'Мой проект', { maxBytes: 1024 ** 3 }, () => undefined);
    expect(res.skipped).toBe(0);
    const expected = tree(src).filter((l) => !l.startsWith('link-to-secret'));
    expect(tree(res.folder)).toEqual(expected);
    expect(fs.readFileSync(path.join(res.folder, 'data.bin')).equals(big)).toBe(true);

    // Повторная распаковка не перезаписывает, а создаёт «Мой проект (2)»
    const res2 = await extractZip(zipPath, dest, 'Мой проект', { maxBytes: 1024 ** 3 }, () => undefined);
    expect(path.basename(res2.folder)).toBe('Мой проект (2)');
  });

  it('прерывается, если архив больше лимита вложения', async () => {
    const src = path.join(tmp, 'random');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'noise.bin'), Buffer.from(Array.from({ length: 200_000 }, () => Math.floor(Math.random() * 256))));
    const scan = await scanFolder(src);
    await expect(zipFolder(scan, path.join(tmp, 'big.zip'), 50_000, () => undefined)).rejects.toBeInstanceOf(ArchiveTooLargeError);
  });

  it('вредоносный архив: zip-slip пропускается, файлы вне папки не создаются', async () => {
    const zipPath = path.join(tmp, 'evil.zip');
    fs.writeFileSync(
      zipPath,
      craftZip([
        { name: '../../escaped.txt', data: Buffer.from('x') },
        { name: 'C:/Windows/evil.dll', data: Buffer.from('x') },
        { name: 'ok/inside.txt', data: Buffer.from('fine') },
        { name: 'ok/stream.txt:hidden', data: Buffer.from('ads') },
      ]),
    );
    const dest = path.join(tmp, 'evil-dest');
    fs.mkdirSync(dest);
    const res = await extractZip(zipPath, dest, 'evil', { maxBytes: 1024 ** 3 }, () => undefined);
    expect(res.files).toBe(1);
    expect(res.skipped).toBe(3);
    expect(fs.existsSync(path.join(tmp, 'escaped.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(res.folder, 'ok', 'inside.txt'), 'utf8')).toBe('fine');
  });

  it('zip-бомба: распакованных данных больше заявленного — распаковка останавливается', async () => {
    const zipPath = path.join(tmp, 'bomb.zip');
    fs.writeFileSync(zipPath, craftZip([{ name: 'bomb.bin', data: Buffer.alloc(5_000_000), declaredSize: 100 }]));
    const dest = path.join(tmp, 'bomb-dest');
    fs.mkdirSync(dest);
    await expect(extractZip(zipPath, dest, 'bomb', { maxBytes: 1024 ** 3 }, () => undefined)).rejects.toThrow(/не совпадает/);
  });

  it('слишком большое заявленное содержимое отклоняется до распаковки', async () => {
    const zipPath = path.join(tmp, 'huge.zip');
    fs.writeFileSync(zipPath, craftZip([{ name: 'a.bin', data: Buffer.alloc(10), declaredSize: 2_000_000_000 }]));
    const idx = await readZipIndex(zipPath);
    expect(idx[0].usize).toBe(2_000_000_000);
    await expect(extractZip(zipPath, tmp, 'huge', { maxBytes: 1024 ** 3 }, () => undefined)).rejects.toThrow(/слишком большое/);
  });
});
