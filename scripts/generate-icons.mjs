// Генерация фирменной иконки Realism Voice (PNG/ICO) из SVG.
// Запуск: npm run icons
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import fs from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve('build');
await fs.mkdir(out, { recursive: true });

const svg = (size, pad = 0) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${-pad} ${-pad} ${64 + pad * 2} ${64 + pad * 2}">
  <defs>
    <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5b7cfa"/>
      <stop offset="1" stop-color="#a855f7"/>
    </linearGradient>
    <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="56" height="56" rx="18" fill="url(#g1)"/>
  <rect x="4" y="4" width="56" height="28" rx="18" fill="url(#g2)"/>
  <g fill="#ffffff">
    <rect x="15" y="27" width="5" height="10" rx="2.5" opacity="0.85"/>
    <rect x="23.5" y="20" width="5" height="24" rx="2.5"/>
    <rect x="32" y="14" width="5" height="36" rx="2.5"/>
    <rect x="40.5" y="22" width="5" height="20" rx="2.5"/>
    <rect x="49" y="28" width="4" height="8" rx="2" opacity="0.85"/>
  </g>
</svg>`;

const render = (size) => sharp(Buffer.from(svg(size))).resize(size, size).png().toBuffer();

await fs.writeFile(path.join(out, 'icon.svg'), svg(512));
await fs.writeFile(path.join(out, 'icon.png'), await render(512));
await fs.writeFile(path.join(out, 'tray.png'), await render(32));

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map(render));
await fs.writeFile(path.join(out, 'icon.ico'), await pngToIco(pngs));
console.log('Иконки сохранены в build/: icon.png, icon.ico, tray.png, icon.svg');
