// Создаёт ключ подписи манифестов: приватный — в secrets/ (не попадает в Git), публичный — в package.json.
// Приватный ключ на экран не выводится. Существующий ключ не перезаписывается.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keyFile = path.join(root, 'secrets', 'update-signing-key.pem');
const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));

if (fs.existsSync(keyFile) || pkg.updatePublicKeys?.length) {
  console.error('Ключ уже есть. Смена ключа выполняется вручную: см. README, раздел 4а.');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(keyFile), { recursive: true });
fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });

const { build, ...rest } = pkg;
const updatePublicKeys = [publicKey.export({ type: 'spki', format: 'der' }).toString('base64')];
fs.writeFileSync(pkgFile, `${JSON.stringify({ ...rest, updatePublicKeys, build }, null, 2)}\n`);

console.log(`Приватный ключ: ${path.relative(root, keyFile)}`);
console.log(`Публичный ключ добавлен в package.json: ${updatePublicKeys[0]}`);
