// Подписывает latest.yml. Использование: sign-update-manifest.mjs <файл> [публичный ключ для проверки]
// Приватный ключ читается из переменной окружения UPDATE_SIGNING_KEY и никуда не выводится.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const yaml = require('js-yaml');
const { canonicalManifest, verifyManifest, SIGNATURE_FIELD } = require(path.join(root, 'dist-electron', 'updateManifest.js'));

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const [file, expectedKey] = process.argv.slice(2);
const privateKey = process.env.UPDATE_SIGNING_KEY;
if (!file) fail('Не указан файл манифеста.');
if (!privateKey) fail('Не задан секрет UPDATE_SIGNING_KEY.');

const text = fs.readFileSync(file, 'utf8').replace(new RegExp(`^${SIGNATURE_FIELD}:.*\\r?\\n?`, 'm'), '');
const manifest = yaml.load(text);
const canonical = canonicalManifest(manifest);
if (canonical === null) fail('Манифест не содержит версию и файлы с SHA-512.');
if (typeof manifest.releaseNotes !== 'string') fail('В манифесте нет описания изменений (build/release-notes.md).');

let signature;
try {
  signature = crypto.sign(null, Buffer.from(canonical), crypto.createPrivateKey(privateKey)).toString('base64');
} catch {
  fail('UPDATE_SIGNING_KEY не является ключом Ed25519.');
}
const signed = `${text.replace(/\s*$/, '')}\n${SIGNATURE_FIELD}: ${signature}\n`;

// Ключ должен соответствовать закреплённому в приложении, иначе пользователи отклонят это обновление
const pinned = expectedKey ? [expectedKey] : JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).updatePublicKeys ?? [];
if (!verifyManifest(yaml.load(signed), pinned)) fail('Ключ подписи не соответствует публичному ключу в package.json.');

fs.writeFileSync(file, signed);
console.log(`Манифест подписан: ${file}`);
