// Проверки конвейера публикации.
//   pre <тег>  — перед сборкой: версия, канал обновлений, описание изменений, решение о подписи
//   post       — после сборки: latest.yml соответствует установщику, в приложении нет токенов
//   repo       — печатает owner/repo канала обновлений
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const channel = pkg.build.publish[0];
const errors = [];

function pre(tag) {
  if (tag !== `v${pkg.version}`) errors.push(`Тег ${tag} не совпадает с версией в package.json (${pkg.version}).`);
  if (channel.owner.startsWith('REPLACE_')) errors.push('В package.json (build.publish[0].owner) не указан владелец GitHub-репозитория.');
  const notes = path.join(root, 'build', 'release-notes.md');
  if (!fs.existsSync(notes) || !fs.readFileSync(notes, 'utf8').includes(pkg.version)) {
    errors.push(`В build/release-notes.md нет описания версии ${pkg.version}.`);
  }
  if (process.env.HAS_RELEASES_TOKEN !== 'true') {
    errors.push(`Не задан секрет RELEASES_GH_TOKEN с правом записи в ${channel.owner}/${channel.repo}.`);
  }
  const url = process.env.VITE_SUPABASE_URL ?? '';
  const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '';
  if (!url || !key) errors.push('Не заданы переменные VITE_SUPABASE_URL и VITE_SUPABASE_PUBLISHABLE_KEY: обновление разошлось бы без подключения к серверу.');
  if (key.startsWith('sb_secret_') || Buffer.from(key.split('.')[1] ?? '', 'base64').toString().includes('service_role')) {
    errors.push('В VITE_SUPABASE_PUBLISHABLE_KEY указан секретный ключ: он попал бы в приложение.');
  }
  if (process.env.HAS_SIGNING_CERT !== 'true' && process.env.ALLOW_UNSIGNED_UPDATES !== 'true') {
    errors.push(
      'Сертификат подписи не настроен. Без него обновления защищены только SHA-512 и HTTPS: взлом GitHub-аккаунта позволит разослать вредоносную версию. ' +
        'Добавьте секреты CSC_LINK и CSC_KEY_PASSWORD либо осознанно задайте переменную репозитория ALLOW_UNSIGNED_UPDATES=true.',
    );
  }
}

function post() {
  const dir = path.join(root, 'release');
  const yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
  const field = (name) => yml.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1]?.trim().replace(/^'|'$/g, '');
  if (field('version') !== pkg.version) errors.push(`latest.yml описывает версию ${field('version')}, ожидалась ${pkg.version}.`);
  const exe = path.join(dir, field('path'));
  const actual = crypto.createHash('sha512').update(fs.readFileSync(exe)).digest('base64');
  if (actual !== field('sha512')) errors.push('SHA-512 установщика не совпадает с latest.yml.');
  if (!fs.existsSync(`${exe}.blockmap`)) errors.push('Нет файла .blockmap для дифференциальной загрузки.');
  const config = fs.readFileSync(path.join(dir, 'win-unpacked', 'resources', 'app-update.yml'), 'utf8');
  if (/token/i.test(config)) errors.push('В app-update.yml попал токен.');
  if (!config.includes(`owner: ${channel.owner}`) || !config.includes(`repo: ${channel.repo}`)) errors.push('app-update.yml указывает не на тот репозиторий.');
}

const [command, arg] = process.argv.slice(2);
if (command === 'pre') pre(arg);
else if (command === 'post') post();
else if (command === 'repo') console.log(`${channel.owner}/${channel.repo}`);
else errors.push('Использование: check-release.mjs pre <тег> | post | repo');

if (errors.length > 0) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
