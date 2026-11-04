// Отдельное тестовое приложение «Realism Voice Update Test» версий 1.0.3 и 1.0.4.
// У него свои appId, папка установки, userData и exe-файл, поэтому рабочая версия не затрагивается.
//   build — собирает оба установщика в release-test/
//   serve — раздаёт версию 1.0.4 с http://127.0.0.1:8484, откуда тестовая 1.0.3 получает обновление
import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'Realism Voice Update Test';
const OLD_VERSION = '1.0.3';
const NEW_VERSION = '1.0.4';
const PORT = 8484;

/** Свой ключ тестового приложения: боевой ключ подписи здесь не нужен */
function testKey() {
  const file = path.join(root, 'release-test', 'update-test-key.pem');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const pem = fs.readFileSync(file, 'utf8');
  return { pem, publicKey: crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64') };
}

async function buildVersion(version) {
  const { build, Platform, Arch } = require('electron-builder');
  const key = testKey();
  const base = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build;
  const config = {
    ...base,
    appId: 'com.realism.voice.updatetest',
    productName: NAME,
    directories: { output: `release-test/${version}`, buildResources: 'build' },
    extraMetadata: { name: 'realism-voice-update-test', productName: NAME, version, updatePublicKeys: [key.publicKey] },
    publish: [{ provider: 'generic', url: `http://127.0.0.1:${PORT}/`, useMultipleRangeRequest: false }],
    releaseInfo: { releaseNotes: `Тестовая версия ${version}.\n- Проверка механизма обновлений.` },
    nsis: {
      ...base.nsis,
      artifactName: `RealismVoice-UpdateTest-${version}-Setup.exe`,
      shortcutName: NAME,
      uninstallDisplayName: NAME,
      createDesktopShortcut: false,
    },
  };
  // Файлом, а не объектом: объект electron-builder объединил бы с publish из package.json
  const configFile = path.join(root, 'release-test', `config-${version}.json`);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  await build({ targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), publish: 'never', config: configFile });
  execFileSync(process.execPath, [path.join(root, 'scripts', 'sign-update-manifest.mjs'), path.join(root, 'release-test', version, 'latest.yml'), key.publicKey], {
    env: { ...process.env, UPDATE_SIGNING_KEY: key.pem },
    stdio: 'inherit',
  });
}

const command = process.argv[2];
if (command === 'build') {
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
  await buildVersion(OLD_VERSION);
  await buildVersion(NEW_VERSION);
  console.log(`\nГотово: release-test/${OLD_VERSION}/RealismVoice-UpdateTest-${OLD_VERSION}-Setup.exe`);
} else if (command === 'serve') {
  const { createFeedServer } = require('./update-feed-server.cjs');
  const dirs = [NEW_VERSION, OLD_VERSION].map((v) => path.join(root, 'release-test', v));
  const server = createFeedServer((name) => {
    if (path.basename(name) !== name) return null;
    return dirs.map((d) => path.join(d, name)).find((f) => fs.existsSync(f)) ?? null;
  });
  server.listen(PORT, '127.0.0.1', () => console.log(`Версия ${NEW_VERSION} доступна на http://127.0.0.1:${PORT}/ (Ctrl+C — остановить)`));
} else {
  console.error('Использование: update-test.mjs build | serve');
  process.exit(1);
}
