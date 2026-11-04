// Проверка системы обновлений без окон. Запускается через node и порождает скрытые процессы Electron.
//   logic   — настоящий electron-updater и electron/updater.ts против локального сервера со сбоями
//   install — реальная установка тестовых 1.0.3 → 1.0.4 (нужен npm run update-test:build); рабочая версия не затрагивается
//   boot    — настоящий main.js из установленной сборки со скрытым окном: IPC, preload и интерфейс
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const APP_NAME = 'Realism Voice Update Test';
const EXE = `${APP_NAME}.exe`;
const CACHE_DIR = path.join(process.env.LOCALAPPDATA ?? '', 'realism-voice-update-test-updater');
const USER_DATA = path.join(process.env.APPDATA ?? '', APP_NAME);
const INSTALLER = (v) => path.join(root, 'release-test', v, `RealismVoice-UpdateTest-${v}-Setup.exe`);
const STAGE_TMP = path.join(os.tmpdir(), 'rv-updater-stage'); // удаляет родительский процесс: Electron держит файлы до выхода
const PERSIST = {
  key: 'rv-update-persist-test',
  secure: 'значение сессии',
  prefs: JSON.stringify({ microphone: 'тест', volume: 73 }),
  settings: { closeToTray: false, hotkeys: { toggleMute: 'Ctrl+Alt+K' }, ptt: { code: 'KeyV', label: 'V' } },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function ok(condition, name, detail = '') {
  console.log(`${condition ? '  OK  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failed++;
}

async function waitFor(fn, name, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Не дождались: ${name}`);
    await sleep(50);
  }
}

// ---------- Сценарии логики (внутри Electron) ----------
async function logicStage(electron) {
  const { app } = electron;
  app.setVersion('1.0.3');
  const tmp = STAGE_TMP;
  fs.mkdirSync(tmp, { recursive: true });
  app.setPath('userData', path.join(tmp, 'userData'));
  const cacheName = `rv-updater-test-${process.pid}`;
  const body = crypto.randomBytes(6 * 1024 * 1024);
  const yaml = require('js-yaml');
  const { canonicalManifest } = require(path.join(root, 'dist-electron', 'updateManifest.js'));
  const signingKeys = crypto.generateKeyPairSync('ed25519');
  const foreignKeys = crypto.generateKeyPairSync('ed25519');
  const publicKey = signingKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  // tamper — подмена манифеста после подписи, signWith — чужой ключ
  const feed = { version: '1.0.3', mode: 'ok', notes: null, hits: { yml: 0, exe: 0 }, tamper: null, signWith: signingKeys.privateKey };
  // У каждой версии своё содержимое: файл с той же суммой electron-updater законно берёт из кэша
  const versionPayload = () => {
    const unique = Buffer.from(body);
    unique.write(feed.version, 0);
    return unique;
  };
  const server = http.createServer((req, res) => {
    const payload = versionPayload();
    if (req.url.startsWith('/latest.yml')) {
      feed.hits.yml++;
      const sha512 = crypto.createHash('sha512').update(payload).digest('base64');
      const url = `app-${feed.version}.exe`;
      const doc = { version: feed.version, files: [{ url, sha512, size: payload.length }], path: url, sha512, releaseDate: '2026-11-04T00:00:00.000Z', releaseNotes: feed.notes };
      doc.rvSignature = crypto.sign(null, Buffer.from(canonicalManifest(doc)), feed.signWith).toString('base64');
      feed.tamper?.(doc);
      res.end(yaml.dump(doc));
      return;
    }
    if (req.url.includes('.exe') && !req.url.includes('.blockmap')) {
      feed.hits.exe++;
      res.writeHead(200, { 'Content-Length': payload.length, 'Content-Type': 'application/octet-stream' });
      if (feed.mode === 'corrupt') {
        const bad = Buffer.from(payload);
        bad[1000] ^= 0xff;
        res.end(bad);
      } else if (feed.mode === 'drop') {
        res.write(payload.subarray(0, payload.length / 2), () => req.socket.destroy());
      } else if (feed.mode === 'slow') {
        const chunk = payload.length / 16;
        let sent = 0;
        const timer = setInterval(() => {
          res.write(payload.subarray(sent, sent + chunk));
          sent += chunk;
          if (sent >= payload.length) {
            clearInterval(timer);
            res.end();
          }
        }, 120);
      } else {
        res.end(payload);
      }
      return;
    }
    res.writeHead(404).end();
  });
  const listen = () => new Promise((r) => server.listen(18484, '127.0.0.1', r));
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });

  const configPath = path.join(tmp, 'app-update.yml');
  fs.writeFileSync(configPath, `provider: generic\nurl: http://127.0.0.1:18484/\nuseMultipleRangeRequest: false\nupdaterCacheDirName: ${cacheName}\n`);

  await app.whenReady();
  const updater = require(path.join(root, 'dist-electron', 'updater.js'));
  const states = [];
  await updater.initUpdater((s) => states.push(s), { configPath, publicKeys: [publicKey], firstCheckDelayMs: 3_600_000, retryDelaysMs: [300, 300, 300] });
  const { autoUpdater } = require('electron-updater');
  const phase = () => updater.getUpdateState().phase;
  const until = (p) => waitFor(() => phase() === p, `состояние ${p}`);

  ok(autoUpdater.autoDownload === false, 'загрузкой управляет приложение (autoDownload выключен)');
  ok(autoUpdater.autoInstallOnAppQuit === false, 'выход из приложения не запускает установку');
  ok(autoUpdater.allowDowngrade === false, 'откат на старую версию запрещён');

  // Сервер недоступен (как при отсутствии интернета), затем появляется
  await updater.checkForUpdates(true);
  ok(phase() === 'error', 'сервер недоступен: честная ошибка, приложение работает', updater.getUpdateState().error);
  ok(updater.getUpdateState().nextRetryAt !== null, 'запланирована повторная попытка');
  await listen();
  await until('not-available');
  ok(true, 'после появления сети повтор сам показал «Установлена последняя версия»');

  // Старая версия на сервере
  feed.version = '1.0.1';
  await updater.checkForUpdates(true);
  ok(phase() === 'not-available', 'более старая версия на сервере не предлагается');

  // Новая версия только показывается: скачивание начинается по кнопке
  feed.version = '1.0.4';
  feed.mode = 'slow';
  feed.notes = '<p>Исправлено <b>многое</b></p><script>alert(1)</script>&amp; ещё';
  feed.hits = { yml: 0, exe: 0 };
  const firstCheck = updater.checkForUpdates(true);
  for (let i = 0; i < 5; i++) void updater.checkForUpdates(true);
  await firstCheck;
  ok(phase() === 'available' && updater.getUpdateState().availableVersion === '1.0.4', 'новая версия найдена');
  ok(feed.hits.exe === 0, 'без нажатия «Обновить» файл не скачивается');
  ok(feed.hits.yml === 1, 'одновременные проверки не дублируются', `запросов latest.yml: ${feed.hits.yml}`);
  ok(updater.installUpdate() === false, 'до скачивания установка невозможна');
  await updater.checkForUpdates(false);
  ok(phase() === 'available' && feed.hits.exe === 0, 'плановая проверка не начинает скачивание');

  // Плановая проверка при обрыве сети не убирает найденную версию
  await close();
  await updater.checkForUpdates(false);
  ok(phase() === 'available', 'сбой сети при плановой проверке не меняет показанное состояние');
  await listen();
  await waitFor(() => updater.getUpdateState().nextRetryAt === null, 'повторная проверка');
  await sleep(50);

  // Настоящий прогресс, защита от параллельных запусков; скачивать можно и во время звонка
  feed.hits = { yml: 0, exe: 0 };
  states.length = 0;
  updater.setInCall(true);
  const first = updater.startDownload();
  ok(phase() === 'downloading', 'скачивание идёт во время звонка');
  for (let i = 0; i < 5; i++) {
    void updater.startDownload();
    void updater.checkForUpdates(true);
  }
  ok(updater.installUpdate() === false, 'во время загрузки установка невозможна');
  await first;
  updater.setInCall(false);
  ok(phase() === 'downloaded', 'обновление загружено и проверено');
  ok(feed.hits.yml === 0, 'во время загрузки проверки не запускаются', `запросов latest.yml: ${feed.hits.yml}`);
  ok(feed.hits.exe === 1, 'одновременные загрузки не дублируются', `запросов файла: ${feed.hits.exe}`);
  const progress = states.map((s) => s.progress).filter(Boolean);
  ok(progress.length > 1 && progress.every((p, i) => i === 0 || p.transferred >= progress[i - 1].transferred), 'прогресс настоящий и растёт', `событий: ${progress.length}`);
  ok(progress.at(-1).total === body.length && progress.at(-1).bytesPerSecond > 0, 'известны размер и скорость', `${progress.at(-1).total} байт, ${progress.at(-1).bytesPerSecond} байт/с`);
  const notes = updater.getUpdateState().releaseNotes ?? '';
  ok(notes.includes('Исправлено многое') && !/[<>]|alert/.test(notes), 'описание изменений очищено от HTML', JSON.stringify(notes));

  // Звонок
  updater.setInCall(true);
  ok(updater.installUpdate() === false && phase() === 'downloaded', 'во время звонка main-процесс отказывает в установке');
  updater.setInCall(false);

  // Повторная проверка той же версии
  feed.mode = 'ok';
  const hits = feed.hits.exe;
  await updater.checkForUpdates(false);
  ok(phase() === 'downloaded' && feed.hits.exe === hits, 'плановая проверка не скачивает файл заново');

  // Повреждённый файл: не принимается, повтор получает исправный
  feed.version = '1.0.5';
  feed.mode = 'corrupt';
  feed.hits.exe = 0;
  await updater.checkForUpdates(true);
  ok(phase() === 'available', 'более новая версия заменила показанную');
  await updater.startDownload();
  ok(phase() === 'error', 'повреждённый файл отклонён', updater.getUpdateState().error);
  ok(updater.installUpdate() === false, 'повреждённый файл нельзя установить');
  const pending = path.join(process.env.LOCALAPPDATA, cacheName, 'pending');
  ok(!fs.existsSync(path.join(pending, 'app-1.0.5.exe')), 'повреждённый файл удалён');
  feed.mode = 'ok';
  await until('downloaded');
  ok(updater.getUpdateState().availableVersion === '1.0.5', 'повторная попытка загрузила исправный файл', `запросов файла: ${feed.hits.exe}`);

  // Обрыв соединения посреди загрузки
  feed.version = '1.0.6';
  feed.mode = 'drop';
  feed.hits.exe = 0;
  await updater.checkForUpdates(true);
  const dropped = updater.startDownload();
  await waitFor(() => feed.hits.exe >= 1 && phase() !== 'downloading', 'обрыв загрузки');
  feed.mode = 'ok';
  await dropped;
  await until('downloaded');
  ok(updater.getUpdateState().availableVersion === '1.0.6', 'после обрыва загрузка завершилась повторной попыткой', `запросов файла: ${feed.hits.exe}`);

  // Отозванный выпуск
  feed.version = '1.0.3';
  await updater.checkForUpdates(true);
  ok(phase() === 'not-available' && updater.installUpdate() === false, 'отозванный выпуск больше не предлагается');

  // Подпись манифеста: ни один из подменённых манифестов не должен дойти до скачивания файла
  feed.version = '1.0.7';
  const attacks = [
    ['нет подписи', (d) => delete d.rvSignature],
    ['подпись испорчена', (d) => { d.rvSignature = Buffer.alloc(64, 7).toString('base64'); }],
    ['чужой ключ', null],
    ['подменён SHA-512', (d) => { d.files[0].sha512 = crypto.randomBytes(64).toString('base64'); }],
    ['подменён файл', (d) => { d.files[0].url = 'evil.exe'; }],
    ['подменён размер', (d) => { d.files[0].size += 1; }],
    ['добавлен второй файл', (d) => { d.files.unshift({ url: 'evil.exe', sha512: 'AAAA', size: 1 }); }],
    ['подменена версия', (d) => { d.version = '1.0.8'; }],
    ['изменено описание', (d) => { d.releaseNotes = 'Срочно установите с evil.example'; }],
    ['запрос прав администратора', (d) => { d.isAdminRightsRequired = true; }],
    ['веб-установщик', (d) => { d.packages = { x64: { path: 'evil.7z', sha512: 'AAAA', size: 1 } }; }],
    ['только устаревшие поля path и sha512', (d) => delete d.files],
  ];
  for (const [name, tamper] of attacks) {
    feed.hits.exe = 0;
    feed.tamper = tamper;
    feed.signWith = tamper ? signingKeys.privateKey : foreignKeys.privateKey;
    await updater.checkForUpdates(true);
    await updater.startDownload();
    const s = updater.getUpdateState();
    ok(s.phase === 'error' && feed.hits.exe === 0 && s.nextRetryAt === null && s.availableVersion === null && updater.installUpdate() === false, `манифест отклонён: ${name}`, s.error);
  }
  feed.tamper = null;
  feed.signWith = signingKeys.privateKey;
  feed.notes = 'Описание версии';
  feed.hits.exe = 0;
  await updater.checkForUpdates(true);
  ok(phase() === 'available' && feed.hits.exe === 0, 'исправно подписанный манифест принят', `version ${updater.getUpdateState().availableVersion}`);

  // Подмена между показом версии и нажатием «Обновить»: electron-updater уже запомнил поддельный манифест
  feed.tamper = (d) => { d.files[0].url = 'evil.exe'; };
  await updater.checkForUpdates(false);
  await updater.startDownload();
  ok(phase() === 'error' && feed.hits.exe === 0 && updater.getUpdateState().availableVersion === null, 'кнопка «Обновить» не скачивает манифест, подменённый после показа версии');
  feed.tamper = null;
  await updater.checkForUpdates(true);
  await updater.startDownload();
  ok(phase() === 'downloaded' && feed.hits.exe === 1, 'после исправной проверки скачивание снова работает');
  feed.version = '1.0.8';
  feed.tamper = (d) => delete d.rvSignature;
  await updater.checkForUpdates(true);
  ok(phase() === 'downloaded' && updater.getUpdateState().availableVersion === '1.0.7', 'подменённый манифест не отменяет уже проверенное обновление');
  feed.tamper = null;
  await updater.checkForUpdates(true);
  ok(phase() === 'available' && updater.getUpdateState().availableVersion === '1.0.8' && updater.installUpdate() === false, 'новая версия заменяет скачанную старую: установка недоступна до скачивания');

  await close();
  fs.rmSync(path.join(process.env.LOCALAPPDATA, cacheName), { recursive: true, force: true });
}

// ---------- Загрузка и запуск установщика 1.0.4 из установленной 1.0.3 (внутри Electron) ----------
async function installStage(electron, installDir) {
  const { app } = electron;
  app.setVersion('1.0.3');
  app.setName(APP_NAME);
  await app.whenReady();
  // Код и зависимости берутся из asar установленной версии: так же, как в настоящем приложении
  const asar = path.join(installDir, 'resources', 'app.asar');
  const updater = require(path.join(asar, 'dist-electron', 'updater.js'));
  await updater.initUpdater(() => undefined, { configPath: path.join(installDir, 'resources', 'app-update.yml'), firstCheckDelayMs: 3_600_000 });
  await updater.checkForUpdates(true);
  ok(updater.getUpdateState().phase === 'available', 'установленная 1.0.3 нашла 1.0.4 и ждёт кнопку «Обновить»', updater.getUpdateState().error ?? '');
  await updater.startDownload();
  const state = updater.getUpdateState();
  ok(state.phase === 'downloaded', 'по кнопке 1.0.4 скачана и проверена', `${state.phase} ${state.error ?? ''}`);
  ok(state.availableVersion === '1.0.4', 'доступная версия определена верно');
  ok(state.releaseNotes?.includes('Тестовая версия 1.0.4'), 'описание изменений получено из latest.yml');
  ok(fs.readFileSync(path.join(root, 'release-test', '1.0.4', 'latest.yml'), 'utf8').includes('rvSignature:'), 'манифест подписан; ключ взят из package.json внутри установленной версии');
  if (state.phase !== 'downloaded') return;
  // Отличие от настоящего запуска: без --force-run, чтобы не открывать окно приложения
  const { autoUpdater } = require(path.join(asar, 'node_modules', 'electron-updater'));
  autoUpdater.quitAndInstall(true, false);
  await sleep(60_000);
}

// ---------- Настоящий main.js со скрытым окном (внутри Electron) ----------
// mode: boot — проверка IPC; boot-write и boot-read — данные пользователя через настоящие main.js и preload до и после обновления
async function bootStage(electron, installDir, mode) {
  const Module = require('node:module');
  const { app, BrowserWindow, session } = electron;
  app.setName(APP_NAME);
  app.setAsDefaultProtocolClient = () => true; // ссылки realismvoice:// остаются за рабочей версией
  app.setPath('userData', mode === 'boot' ? STAGE_TMP : USER_DATA);
  let win = null;
  class HiddenWindow extends BrowserWindow {
    constructor(options) {
      super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true } });
      win = this;
    }
    show() {}
    focus() {}
  }
  class FakeTray {
    setToolTip() {}
    setContextMenu() {}
    on() {}
  }
  const fakes = { BrowserWindow: HiddenWindow, Tray: FakeTray, globalShortcut: { register() {}, unregisterAll() {} } };
  const proxy = new Proxy(electron, { get: (target, key) => fakes[key] ?? target[key] });
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'electron' ? proxy : load.call(this, request, ...rest);
  };
  require(path.join(installDir, 'resources', 'app.asar', 'dist-electron', 'main.js'));
  await app.whenReady();
  await waitFor(() => win && !win.webContents.isLoading(), 'загрузка интерфейса');
  const exec = (code) => win.webContents.executeJavaScript(code);
  if (mode === 'boot-write') {
    await exec(`window.rv.storage.setItem(${JSON.stringify(PERSIST.key)}, ${JSON.stringify(PERSIST.secure)})`);
    await exec(`window.rv.app.setSettings(${JSON.stringify(PERSIST.settings)})`);
    await exec(`localStorage.setItem(${JSON.stringify(PERSIST.key)}, ${JSON.stringify(PERSIST.prefs)})`);
    session.defaultSession.flushStorageData();
    await sleep(1500);
    ok(fs.existsSync(path.join(USER_DATA, 'session.bin')), `версия ${JSON.parse(fs.readFileSync(path.join(installDir, 'resources', 'app.asar', 'package.json'))).version}: записаны зашифрованная сессия, настройки и локальные предпочтения`, await exec('location.origin'));
    return;
  }
  if (mode === 'boot-read') {
    const version = JSON.parse(fs.readFileSync(path.join(installDir, 'resources', 'app.asar', 'package.json'))).version;
    ok((await exec(`window.rv.storage.getItem(${JSON.stringify(PERSIST.key)})`)) === PERSIST.secure, `версия ${version}: зашифрованная сессия расшифрована (DPAPI)`);
    const settings = await exec('window.rv.app.getSettings()');
    ok(settings.hotkeys.toggleMute === PERSIST.settings.hotkeys.toggleMute && settings.ptt?.code === PERSIST.settings.ptt.code && settings.closeToTray === PERSIST.settings.closeToTray, `версия ${version}: настройки и горячие клавиши сохранились`);
    ok((await exec(`localStorage.getItem(${JSON.stringify(PERSIST.key)})`)) === PERSIST.prefs, `версия ${version}: предпочтения (микрофон, громкость) сохранились`, await exec('location.origin'));
    return;
  }
  const state = await waitFor(() => exec('window.rv.updates.getState()'), 'ответ IPC');
  ok(state.phase === 'disabled' && state.disabledReason === 'dev', 'main.js запустился, IPC и preload обновлений работают', JSON.stringify({ phase: state.phase, reason: state.disabledReason }));
  ok((await exec('window.rv.updates.install()')) === false, 'запрос установки без готового обновления отклонён');
  await exec('window.rv.updates.download()');
  ok((await exec('window.rv.updates.getState()')).phase === 'disabled', 'запрос скачивания без проверенного манифеста ничего не запускает');
  await exec('window.rv.updates.setInCall(true)');
  await waitFor(() => exec('document.querySelector("#root")?.childElementCount > 0'), 'отрисовка интерфейса');
  ok(true, 'интерфейс установленной сборки отрисовался');
}

// ---------- Оркестратор (обычный node) ----------
function runElectron(stage, arg) {
  const electronPath = require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => {
    const child = spawn(electronPath, [__filename, '--electron-stage', stage, arg ?? ''], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => {
      fs.rmSync(STAGE_TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      resolve(code ?? 1);
    });
  });
}

function asarVersion(asarPath) {
  const asar = require('@electron/asar');
  asar.uncache(asarPath); // заголовок кэшируется, а файл после обновления другой
  return JSON.parse(asar.extractFile(asarPath, 'package.json').toString()).version;
}

function runInstaller(file, args) {
  // NSIS требует /D= последним аргументом и без кавычек
  const result = spawnSync(`"${file}" ${args}`, { shell: true, stdio: 'ignore' });
  if (result.status !== 0) throw new Error(`Установщик завершился с кодом ${result.status}`);
}

function fileHash(file) {
  return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
}

function protocolHandler() {
  try {
    return execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\realismvoice\\shell\\open\\command', '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

async function orchestrate() {
  console.log('\n== Логика обновлений (настоящий electron-updater, локальный сервер со сбоями) ==');
  const logicCode = await runElectron('logic');
  if (logicCode !== 0) failed++;

  if (!fs.existsSync(INSTALLER('1.0.3')) || !fs.existsSync(INSTALLER('1.0.4'))) {
    console.log('\nТестовые установщики не собраны: реальная установка пропущена (npm run update-test:build).');
    return;
  }

  console.log('\n== Реальная установка 1.0.3 и обновление до 1.0.4 (тихий режим, отдельное тестовое приложение) ==');
  const realExe = path.join(process.env.LOCALAPPDATA, 'Programs', 'Realism Voice', 'Realism Voice.exe');
  const before = { exe: fileHash(realExe), protocol: protocolHandler() };
  const installDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-install-')), 'app');
  const asar = path.join(installDir, 'resources', 'app.asar');
  const sentinels = ['sentinel.txt', path.join('Local Storage', 'sentinel.txt')].map((f) => path.join(USER_DATA, f));
  const { createFeedServer } = require('./update-feed-server.cjs');
  const dirs = ['1.0.4', '1.0.3'].map((v) => path.join(root, 'release-test', v));
  const hits = [];
  const server = createFeedServer((name) => {
    hits.push(name);
    return dirs.map((d) => path.join(d, name)).find((f) => fs.existsSync(f)) ?? null;
  });
  await new Promise((r) => server.listen(8484, '127.0.0.1', r));

  try {
    runInstaller(INSTALLER('1.0.3'), `/S /D=${installDir}`);
    ok(fs.existsSync(path.join(installDir, EXE)) && asarVersion(asar) === '1.0.3', 'установлена тестовая 1.0.3', installDir);
    ok(fs.readFileSync(path.join(installDir, 'resources', 'app-update.yml'), 'utf8').includes('provider: generic'), 'app-update.yml создан в установленной версии');
    for (const f of sentinels) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `данные пользователя ${path.basename(f)}`);
    }

    if ((await runElectron('boot', installDir)) !== 0) failed++;
    if ((await runElectron('boot-write', installDir)) !== 0) failed++;
    console.log('');
    if ((await runElectron('install', installDir)) !== 0) failed++;
    const installed = await waitFor(() => {
      const busy = execFileSync('tasklist', { encoding: 'utf8' }).includes('RealismVoice-UpdateTest');
      return !busy && fs.existsSync(asar) && asarVersion(asar) === '1.0.4';
    }, 'установка 1.0.4', 180_000).catch(() => false);
    ok(installed, 'установщик заменил файлы: версия 1.0.4 в той же папке', fs.existsSync(asar) ? asarVersion(asar) : 'нет файлов');
    ok(fs.existsSync(path.join(installDir, EXE)), 'исполняемый файл на месте');
    ok(hits.some((h) => h.endsWith('1.0.3-Setup.exe.blockmap')) || fs.existsSync(path.join(CACHE_DIR, 'current.blockmap')), 'использованы блок-карты для дифференциальной загрузки', hits.filter((h) => h.endsWith('.blockmap')).join(', '));
    const log = path.join(USER_DATA, 'logs', 'updater.log');
    ok(sentinels.every((f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').startsWith('данные пользователя')), 'данные пользователя в userData сохранились');
    if ((await runElectron('boot-read', installDir)) !== 0) failed++;
    ok(!fs.existsSync(log) || !/token/i.test(fs.readFileSync(log, 'utf8')), 'журнал обновлений не содержит токенов');
    if (fs.existsSync(log)) {
      const lines = fs.readFileSync(log, 'utf8').split('\n').filter((l) => /differentially|block maps|Full:|File has|downloaded to/i.test(l));
      for (const l of lines.slice(-6)) console.log(`       ${l.slice(0, 180)}`);
    }
  } finally {
    server.closeAllConnections();
    server.close();
    const uninstaller = path.join(installDir, `Uninstall ${APP_NAME}.exe`);
    if (fs.existsSync(uninstaller)) runInstaller(uninstaller, '/S');
    await sleep(4000);
    fs.rmSync(path.dirname(installDir), { recursive: true, force: true });
    fs.rmSync(USER_DATA, { recursive: true, force: true });
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  }

  console.log('\n== Рабочая версия не затронута ==');
  ok(fileHash(realExe) === before.exe, 'файлы установленного Realism Voice не изменились');
  ok(protocolHandler() === before.protocol, 'ссылки realismvoice:// остались за рабочей версией');
}

const stageIndex = process.argv.indexOf('--electron-stage');
if (stageIndex !== -1) {
  const electron = require('electron');
  const [stage, arg] = process.argv.slice(stageIndex + 1);
  electron.app.on('window-all-closed', () => {});
  // Неожиданный выход не должен выглядеть как успех: штатно завершается только этап установки
  if (stage !== 'install') electron.app.on('before-quit', () => electron.app.exit(3));
  const run = stage === 'logic' ? logicStage(electron) : stage === 'install' ? installStage(electron, arg) : bootStage(electron, arg, stage);
  run.then(
    () => electron.app.exit(failed === 0 ? 0 : 1),
    (err) => {
      console.error(err);
      electron.app.exit(1);
    },
  );
} else {
  orchestrate().then(
    () => {
      console.log(failed === 0 ? '\nВсе проверки пройдены.' : `\nНе пройдено проверок: ${failed}`);
      process.exit(failed === 0 ? 0 : 1);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
