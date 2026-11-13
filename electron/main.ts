import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  Menu,
  nativeImage,
  powerMonitor,
  protocol,
  session,
  shell,
  Tray,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, DeepLink } from './shared';
import { loadSettings, updateSettings } from './settings';
import * as secureStore from './secureStore';
import { globalPttAvailable, initPtt, setPttBinding, stopHook } from './ptt';
import { checkForUpdates, getUpdateState, initUpdater, installUpdate, setInCall, startDownload } from './updater';
import { setupTransfers } from './transfers';
import { setupNetDiagnostics } from './netDiagnostics';

// Тестовая сборка обновлений ставится рядом с рабочей и не должна перехватывать её ссылки realismvoice://
const IS_UPDATE_TEST_BUILD = app.getName() === 'Realism Voice Update Test';
const APP_SCHEME = 'app';
const APP_HOST = 'rv';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const DEEP_LINK_SCHEME = 'realismvoice';
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const IS_DEV = !!DEV_URL && !app.isPackaged;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
};

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let pendingDeepLink: DeepLink | null = null;
let pendingScreen: { id: string; withAudio: boolean } | null = null;
let pttActive = false;
const downloadNames = new Map<string, string>();

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

// ---------- Один экземпляр + deep links ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

if (IS_UPDATE_TEST_BUILD) {
  /* ссылки realismvoice:// остаются за рабочей версией */
} else if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
}
app.setAppUserModelId(app.isPackaged ? (IS_UPDATE_TEST_BUILD ? 'com.realism.voice.updatetest' : 'com.realism.voice') : process.execPath);

const initialSettings = loadSettings();
if (!initialSettings.hardwareAcceleration) app.disableHardwareAcceleration();

function parseDeepLink(raw: unknown): DeepLink | null {
  if (typeof raw !== 'string' || raw.length > 4096 || !raw.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const route = url.pathname.replace(/^\/+|\/+$/g, '');
  if (host === 'auth' && (route === 'callback' || route === 'reset')) {
    const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
    const get = (k: string) => url.searchParams.get(k) ?? hash.get(k);
    const code = get('code');
    return {
      type: 'auth',
      action: route,
      code: code && /^[A-Za-z0-9-_.]{6,512}$/.test(code) ? code : null,
      error: (get('error_code') ?? get('error'))?.slice(0, 100) ?? null,
      errorDescription: get('error_description')?.slice(0, 300) ?? null,
    };
  }
  if (host === 'invite' && /^[A-Za-z0-9]{6,16}$/.test(route)) {
    return { type: 'invite', code: route };
  }
  return null;
}

function deliverDeepLink(link: DeepLink | null) {
  if (!link) return;
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('deeplink', link);
  } else {
    pendingDeepLink = link;
  }
  showWindow();
}

app.on('second-instance', (_e, argv) => {
  deliverDeepLink(parseDeepLink(argv.find((a) => a.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`))));
  showWindow();
});
app.on('open-url', (e, url) => {
  e.preventDefault();
  deliverDeepLink(parseDeepLink(url));
});
pendingDeepLink = parseDeepLink(process.argv.find((a) => a.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`)));

// ---------- Ресурсы ----------
function resourcePath(file: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, file) : path.join(__dirname, '..', 'build', file);
}

function rendererDist(): string {
  return path.join(__dirname, '..', 'dist');
}

function isTrustedUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (url.startsWith(`${APP_ORIGIN}/`)) return true;
  if (IS_DEV && DEV_URL && url.startsWith(DEV_URL)) return true;
  return false;
}

function assertSender(e: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const frame = e.senderFrame;
  return !!frame && frame === e.sender.mainFrame && isTrustedUrl(frame.url);
}

// ---------- Окно ----------
function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  const settings = loadSettings();
  const startHidden = settings.startMinimized && process.argv.includes('--hidden');
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Realism Voice',
    backgroundColor: '#05060c',
    icon: resourcePath('icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#070912', symbolColor: '#c7cbe0', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      devTools: !app.isPackaged,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!startHidden) mainWindow?.show();
  });

  mainWindow.on('minimize', () => {
    if (loadSettings().minimizeToTray && tray) mainWindow?.hide();
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting && loadSettings().closeToTray && tray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Внешние ссылки — только http(s) в системном браузере; новые окна запрещены
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedUrl(url)) {
      e.preventDefault();
      openExternalSafe(url);
    }
  });
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault());
  mainWindow.webContents.on('render-process-gone', () => setInCall(false));

  if (IS_DEV && DEV_URL) {
    void mainWindow.loadURL(DEV_URL);
  } else {
    void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  }
}

function openExternalSafe(url: unknown) {
  if (typeof url !== 'string' || url.length > 2048) return;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') {
      void shell.openExternal(u.toString());
    }
  } catch {
    /* ignore */
  }
}

// ---------- Трей ----------
function createTray() {
  if (tray) return;
  const img = nativeImage.createFromPath(resourcePath('tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('Realism Voice');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть Realism Voice', click: () => showWindow() },
      { type: 'separator' },
      {
        label: 'Выйти',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => showWindow());
}

// ---------- Горячие клавиши ----------
function registerHotkeys(settings: AppSettings) {
  globalShortcut.unregisterAll();
  const bind = (accel: string, action: 'toggleMute' | 'toggleDeafen') => {
    if (!accel) return;
    try {
      globalShortcut.register(accel, () => mainWindow?.webContents.send('hotkey', action));
    } catch {
      /* недопустимое сочетание */
    }
  };
  bind(settings.hotkeys.toggleMute, 'toggleMute');
  bind(settings.hotkeys.toggleDeafen, 'toggleDeafen');
}

function applyPtt() {
  setPttBinding(pttActive ? loadSettings().ptt : null);
}

function applyAutostart(settings: AppSettings) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: settings.autostart, args: ['--hidden'] });
}

// ---------- Сессия: протокол, CSP, разрешения ----------
function setupSession() {
  const ses = session.defaultSession;
  const dist = rendererDist();

  protocol.handle(APP_SCHEME, async (req) => {
    const url = new URL(req.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    let full = path.normalize(path.join(dist, rel));
    if (!full.startsWith(dist + path.sep)) return new Response('Forbidden', { status: 403 });
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) full = path.join(dist, 'index.html');
    const body = await fs.promises.readFile(full);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    });
  });

  const allowed = new Set([
    'media',
    'notifications',
    'clipboard-sanitized-write',
    'fullscreen',
    'display-capture',
    'speaker-selection',
  ]);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(isTrustedUrl(details.requestingUrl ?? wc.getURL()) && allowed.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    const o = origin ?? '';
    const trusted = o === APP_ORIGIN || o.startsWith(`${APP_ORIGIN}/`) || (IS_DEV && !!DEV_URL && DEV_URL.startsWith(o));
    return trusted && (allowed.has(permission) || permission === 'media');
  });
  ses.setDevicePermissionHandler(() => false);

  // Демонстрация экрана: источник выбирается в UI приложения (screen:select)
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    const selection = pendingScreen;
    pendingScreen = null;
    if (!selection) {
      callback({});
      return;
    }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((s) => s.id === selection.id);
      if (!source) {
        callback({});
        return;
      }
      callback(
        selection.withAudio && process.platform === 'win32'
          ? { video: source, audio: 'loopback' }
          : { video: source },
      );
    } catch {
      callback({});
    }
  });

  ses.on('will-download', (_e, item) => {
    const name = downloadNames.get(item.getURL()) ?? item.getFilename();
    downloadNames.delete(item.getURL());
    const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180) || 'file';
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), safe) });
  });
}

// ---------- IPC ----------
function setupIpc() {
  ipcMain.handle('storage:get', (e, key) => {
    if (!assertSender(e) || !secureStore.validKey(key)) return null;
    return secureStore.getItem(key);
  });
  ipcMain.handle('storage:set', (e, key, value) => {
    if (!assertSender(e) || !secureStore.validKey(key)) return;
    secureStore.setItem(key, value);
  });
  ipcMain.handle('storage:remove', (e, key) => {
    if (!assertSender(e) || !secureStore.validKey(key)) return;
    secureStore.removeItem(key);
  });

  ipcMain.handle('app:version', (e) => {
    if (!assertSender(e)) return null;
    return {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    };
  });

  ipcMain.handle('settings:get', (e) => (assertSender(e) ? loadSettings() : null));
  ipcMain.handle('settings:set', (e, patch) => {
    if (!assertSender(e)) return loadSettings();
    const next = updateSettings(patch);
    registerHotkeys(next);
    applyAutostart(next);
    applyPtt();
    return next;
  });

  ipcMain.handle('app:open-external', (e, url) => {
    if (assertSender(e)) openExternalSafe(url);
  });

  ipcMain.handle('app:download', (e, url, filename) => {
    if (!assertSender(e) || typeof url !== 'string' || !mainWindow) return;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') return;
      downloadNames.set(u.toString(), typeof filename === 'string' ? filename : 'file');
      mainWindow.webContents.downloadURL(u.toString());
    } catch {
      /* ignore */
    }
  });

  ipcMain.on('app:focus', (e) => {
    if (assertSender(e)) showWindow();
  });
  ipcMain.on('app:flash', (e) => {
    if (assertSender(e) && mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  });
  ipcMain.on('app:badge', (e, count) => {
    if (!assertSender(e) || typeof count !== 'number') return;
    const n = Math.max(0, Math.min(9999, Math.floor(count)));
    tray?.setToolTip(n > 0 ? `Realism Voice — непрочитанных: ${n}` : 'Realism Voice');
    if (mainWindow) mainWindow.setTitle(n > 0 ? `(${n}) Realism Voice` : 'Realism Voice');
  });
  ipcMain.on('app:quit', (e) => {
    if (!assertSender(e)) return;
    isQuitting = true;
    app.quit();
  });

  ipcMain.handle('deeplink:consume', (e) => {
    if (!assertSender(e)) return null;
    const link = pendingDeepLink;
    pendingDeepLink = null;
    return link;
  });

  ipcMain.handle('screen:sources', async (e) => {
    if (!assertSender(e)) return [];
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    return sources
      .filter((s) => s.name !== 'Realism Voice' || s.id.startsWith('screen'))
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen') ? 'screen' : 'window',
        thumbnail: s.thumbnail.toDataURL(),
        appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      }));
  });

  ipcMain.handle('screen:select', (e, id, withAudio) => {
    if (!assertSender(e)) return;
    pendingScreen =
      typeof id === 'string' && /^(screen|window):[\w:.-]{1,64}$/.test(id) ? { id, withAudio: withAudio === true } : null;
  });

  ipcMain.handle('ptt:available', (e) => assertSender(e) && globalPttAvailable());
  ipcMain.on('ptt:active', (e, active) => {
    if (!assertSender(e)) return;
    pttActive = active === true;
    applyPtt();
  });

  ipcMain.handle('updates:get', (e) => (assertSender(e) ? getUpdateState() : null));
  ipcMain.handle('updates:check', (e) => {
    if (assertSender(e)) void checkForUpdates(true);
  });
  ipcMain.handle('updates:download', (e) => {
    // Не ждём: загрузка может идти долго, ход виден по событиям updates:state
    if (assertSender(e)) void startDownload();
  });
  ipcMain.handle('updates:install', (e) => assertSender(e) && installUpdate());
  ipcMain.on('updates:in-call', (e, inCall) => {
    if (assertSender(e)) setInCall(inCall === true);
  });

  setupTransfers(() => mainWindow, assertSender);
  setupNetDiagnostics(assertSender);
}

// Сон и пробуждение Windows: интерфейс восстанавливает присутствие и голосовую связь
function setupPowerEvents() {
  for (const ev of ['suspend', 'resume', 'lock-screen', 'unlock-screen'] as const) {
    powerMonitor.on(ev as 'suspend', () => mainWindow?.webContents.send('power', ev));
  }
  // Бездействие: нет ввода с клавиатуры и мыши во всей системе дольше USER_IDLE_SECONDS → статус «Неактивен»
  let idle = false;
  setInterval(() => {
    let seconds = 0;
    try {
      seconds = powerMonitor.getSystemIdleTime();
    } catch {
      return;
    }
    const now = seconds >= USER_IDLE_SECONDS;
    if (now === idle) return;
    idle = now;
    mainWindow?.webContents.send('power', idle ? 'user-idle' : 'user-active');
  }, 15_000).unref();
}

/** Через сколько секунд без действий пользователя статус «В сети» сменяется на «Неактивен» */
const USER_IDLE_SECONDS = 10 * 60;

// ---------- Запуск ----------
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  setupSession();
  setupIpc();
  setupPowerEvents();
  createTray();
  createWindow();
  const settings = loadSettings();
  registerHotkeys(settings);
  applyAutostart(settings);
  initPtt((pressed) => mainWindow?.webContents.send('ptt:state', pressed));
  void initUpdater((state) => mainWindow?.webContents.send('updates:state', state));
});

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopHook();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
