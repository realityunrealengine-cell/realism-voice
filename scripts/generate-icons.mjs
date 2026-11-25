// Генерация иконок Realism Voice (PNG/ICO) из фирменного логотипа.
// Источник — build/logo-source.png (неоновый знак «R» с аудиоволной, 1.3.0). Логотип обрезается по
// скруглённому квадрату, углы становятся прозрачными. Запуск: npm run icons
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import fs from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve('build');
const src = path.join(out, 'logo-source.png');
await fs.mkdir(out, { recursive: true });

// Квадрат знака на исходном изображении 1254×1254 (найден по яркости границы)
const CROP = { left: 52, top: 32, width: 1150, height: 1150 };
const S = CROP.width;
const INSET = 8;
const RADIUS = 220;
const mask = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><rect x="${INSET}" y="${INSET}" width="${S - INSET * 2}" height="${S - INSET * 2}" rx="${RADIUS}" ry="${RADIUS}" fill="#fff"/></svg>`,
);

const master = await sharp(src)
  .extract(CROP)
  .ensureAlpha()
  .composite([{ input: mask, blend: 'dest-in' }])
  .png()
  .toBuffer();

const render = (size) => sharp(master).resize(size, size, { kernel: 'lanczos3' }).png().toBuffer();

await fs.writeFile(path.join(out, 'icon.png'), await render(512));
await fs.writeFile(path.join(out, 'tray.png'), await render(32));
await fs.mkdir(path.resolve('src/assets'), { recursive: true });
await fs.writeFile(path.resolve('src/assets/logo.png'), await render(256));

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map(render));
await fs.writeFile(path.join(out, 'icon.ico'), await pngToIco(pngs));
await fs.rm(path.join(out, 'icon.svg'), { force: true });
console.log('Иконки сохранены: build/icon.png, build/icon.ico, build/tray.png, src/assets/logo.png');
