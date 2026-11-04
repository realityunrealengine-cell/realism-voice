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

  const feed = { version: '1.0.3', mode: 'ok', notes: 'null', hits: { yml: 0, exe: 0 } };
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
      res.end(`version: ${feed.version}\nfiles:\n  - url: app-${feed.version}.exe\n    sha512: ${sha512}\n    size: ${payload.length}\npath: app-${feed.version}.exe\nsha512: ${sha512}\nreleaseDate: '2026-11-04T00:00:00.000Z'\nreleaseNotes: ${feed.notes}\n`);
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
  await updater.initUpdater((s) => states.push(s), { configPath, firstCheckDelayMs: 3_600_000, retryDelaysMs: [300, 300, 300] });
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

  // Настоящий прогресс и защита от параллельных запусков
  feed.version = '1.0.4';
  feed.mode = 'slow';
  feed.notes = "'<p>Исправлено <b>многое</b></p><script>alert(1)</script>&amp; ещё'";
  feed.hits = { yml: 0, exe: 0 };
  states.length = 0;
  const first = updater.checkForUpdates(true);
  for (let i = 0; i < 5; i++) void updater.checkForUpdates(true);
  await until('downloading');
  ok(updater.installUpdate() === false, 'во время загрузки установка невозможна');
  for (let i = 0; i < 5; i++) void updater.checkForUpdates(true);
  await first;
  ok(phase() === 'downloaded', 'обновление загружено и проверено');
  ok(feed.hits.yml === 1, 'одновременные проверки не дублируются', `запросов latest.yml: ${feed.hits.yml}`);
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
  const dropped = updater.checkForUpdates(true);
  await waitFor(() => feed.hits.exe >= 1 && phase() !== 'downloading', 'обрыв загрузки');
  feed.mode = 'ok';
  await dropped;
  await until('downloaded');
  ok(updater.getUpdateState().availableVersion === '1.0.6', 'после обрыва загрузка завершилась повторной попыткой', `запросов файла: ${feed.hits.exe}`);

  // Отозванный выпуск
  feed.version = '1.0.3';
  await updater.checkForUpdates(true);
  ok(phase() === 'not-available' && updater.installUpdate() === false, 'отозванный выпуск больше не предлагается');

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
  const state = updater.getUpdateState();
  ok(state.phase === 'downloaded', 'установленная 1.0.3 нашла и загрузила 1.0.4', `${state.phase} ${state.error ?? ''}`);
  ok(state.availableVersion === '1.0.4', 'доступная версия определена верно');
  ok(state.releaseNotes?.includes('Тестовая версия 1.0.4'), 'описание изменений получено из latest.yml');
  if (state.phase !== 'downloaded') return;
  // Отличие от настоящего запуска: без --force-run, чтобы не открывать окно приложения
  const { autoUpdater } = require(path.join(asar, 'node_modules', 'electron-updater'));
  autoUpdater.quitAndInstall(true, false);
  await sleep(60_000);
}

// ---------- Настоящий main.js со скрытым окном (внутри Electron) ----------
async function bootStage(electron, installDir) {
  const Module = require('node:module');
  const { app, BrowserWindow } = electron;
  app.setName(APP_NAME); // main.js не трогает ссылки realismvoice:// в тестовой сборке
  app.setPath('userData', STAGE_TMP);
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
  const state = await waitFor(() => exec('window.rv.updates.getState()'), 'ответ IPC');
  ok(state.phase === 'disabled' && state.disabledReason === 'dev', 'main.js запустился, IPC и preload обновлений работают', JSON.stringify({ phase: state.phase, reason: state.disabledReason }));
  ok((await exec('window.rv.updates.install()')) === false, 'запрос установки без готового обновления отклонён');
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

function asarVersion(asar) {
  return JSON.parse(require('@electron/asar').extractFile(asar, 'package.json').toString()).version;
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
  const sentinels = ['settings.json', 'session.bin', path.join('Local Storage', 'leveldb', 'prefs.ldb')].map((f) => path.join(USER_DATA, f));
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
  const run = stage === 'logic' ? logicStage(electron) : stage === 'install' ? installStage(electron, arg) : bootStage(electron, arg);
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
