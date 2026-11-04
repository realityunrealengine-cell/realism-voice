// Автообновление через electron-updater и GitHub Releases.
// Обновление скачивается в фоне, но ставится только по явному действию пользователя и не во время звонка.
// Токены здесь не нужны: канал обновлений — публичный репозиторий, адрес берётся из resources/app-update.yml.
import { app, net, powerMonitor } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppUpdater, Logger, ProgressInfo, UpdateInfo } from 'electron-updater';
import type { UpdateState } from './shared';

const PLACEHOLDER_OWNER = 'REPLACE_WITH_GITHUB_OWNER';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MAX_NOTES_LENGTH = 2000;
const MAX_LOG_BYTES = 1024 * 1024;

export interface UpdaterTestOptions {
  configPath: string;
  firstCheckDelayMs?: number;
  retryDelaysMs?: number[];
}

let firstCheckDelayMs = 30_000;
let retryDelaysMs = [30_000, 2 * 60_000, 5 * 60_000, 15 * 60_000];

let updater: AppUpdater | null = null;
let publish: (state: UpdateState) => void = () => undefined;
let busy = false; // идёт проверка или загрузка: параллельно не запускаем
let inCall = false;
let downloadedVersion: string | null = null;
let retryIndex = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

let state: UpdateState = {
  phase: 'disabled',
  disabledReason: 'dev',
  currentVersion: app.getVersion(),
  availableVersion: null,
  releaseNotes: null,
  progress: null,
  error: null,
  lastCheckedAt: null,
  nextRetryAt: null,
  signatureRequired: false,
};

function patch(next: Partial<UpdateState>) {
  state = { ...state, ...next };
  publish(state);
}

function createLogger(): Logger {
  const file = path.join(app.getPath('userData'), 'logs', 'updater.log');
  const write = (level: string, message: unknown) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.old`);
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${String(message)}\n`);
    } catch {
      /* журнал не должен мешать работе приложения */
    }
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
  };
}

/** Описание изменений показывается как обычный текст: GitHub может отдать его в виде HTML */
function plainNotes(info: UpdateInfo): string | null {
  const raw = Array.isArray(info.releaseNotes) ? info.releaseNotes.map((n) => n.note ?? '').join('\n') : info.releaseNotes;
  if (!raw) return null;
  const text = raw
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|li|h\d|ul|ol)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.slice(0, MAX_NOTES_LENGTH) || null;
}

function errorText(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE') return 'Обновление отклонено: цифровая подпись не прошла проверку.';
  if (code === 'ERR_CHECKSUM_MISMATCH' || /sha(2|512) checksum mismatch/i.test(message)) {
    return 'Загруженный файл повреждён и не будет установлен.';
  }
  if (/net::|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(message)) return 'Нет подключения к серверу обновлений.';
  return 'Не удалось получить обновление с сервера.';
}

function isNoReleases(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' || /No published versions/i.test(String(err));
}

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

/** Повтор с нарастающей паузой; когда попытки кончились, следующей будет плановая проверка */
function scheduleRetry() {
  clearRetry();
  const delay = retryDelaysMs[retryIndex];
  if (delay === undefined) {
    patch({ nextRetryAt: null });
    return;
  }
  retryIndex++;
  patch({ nextRetryAt: Date.now() + delay });
  retryTimer = setTimeout(() => void checkForUpdates(false), delay);
}

export async function checkForUpdates(manual: boolean): Promise<void> {
  if (!updater || busy || state.phase === 'installing') return;
  clearRetry();
  const keepReady = state.phase === 'downloaded' && !manual;
  if (manual) retryIndex = 0;
  if (!net.isOnline()) {
    if (manual && state.phase !== 'downloaded') patch({ phase: 'error', error: 'Нет подключения к интернету.' });
    scheduleRetry();
    return;
  }
  const hadDownload = state.phase === 'downloaded';
  busy = true;
  if (!keepReady) patch({ phase: 'checking', error: null, nextRetryAt: null });
  try {
    const result = await updater.checkForUpdates();
    if (!result?.isUpdateAvailable) {
      // Выпуск могли отозвать: загруженную ранее версию больше не предлагаем
      downloadedVersion = null;
      retryIndex = 0;
      patch({ phase: 'not-available', availableVersion: null, releaseNotes: null, progress: null, error: null, lastCheckedAt: Date.now(), nextRetryAt: null });
      return;
    }
    const info = result.updateInfo;
    patch({ availableVersion: info.version, releaseNotes: plainNotes(info), lastCheckedAt: Date.now() });
    if (info.version !== downloadedVersion) {
      downloadedVersion = null;
      patch({ phase: 'downloading', progress: null, error: null, nextRetryAt: null });
      // electron-updater сверяет SHA-512 из latest.yml и подпись (если она настроена); при ошибке файл удаляется
      await updater.downloadUpdate();
      downloadedVersion = info.version;
    }
    retryIndex = 0;
    patch({ phase: 'downloaded', progress: null, error: null, nextRetryAt: null });
  } catch (err) {
    if (isNoReleases(err)) {
      retryIndex = 0;
      patch({ phase: 'not-available', availableVersion: null, releaseNotes: null, progress: null, error: null, lastCheckedAt: Date.now(), nextRetryAt: null });
      return;
    }
    const stillReady = hadDownload && downloadedVersion !== null;
    patch({ phase: stillReady ? 'downloaded' : 'error', progress: null, error: errorText(err) });
    if ((err as { code?: string })?.code !== 'ERR_UPDATER_INVALID_SIGNATURE') scheduleRetry();
  } finally {
    busy = false;
  }
}

export function getUpdateState(): UpdateState {
  return state;
}

export function setInCall(value: boolean) {
  inCall = value;
}

/** Только по действию пользователя: во время звонка установка запрещена и на стороне main */
export function installUpdate(): boolean {
  if (!updater || state.phase !== 'downloaded' || inCall) return false;
  clearRetry();
  if (intervalTimer) clearInterval(intervalTimer);
  patch({ phase: 'installing' });
  // Тихая установка в ту же папку и запуск новой версии после неё
  updater.quitAndInstall(true, true);
  return true;
}

export async function initUpdater(onState: (state: UpdateState) => void, test?: UpdaterTestOptions): Promise<void> {
  publish = onState;
  if (!app.isPackaged && !test) return;
  const configPath = test?.configPath ?? path.join(process.resourcesPath, 'app-update.yml');
  firstCheckDelayMs = test?.firstCheckDelayMs ?? firstCheckDelayMs;
  retryDelaysMs = test?.retryDelaysMs ?? retryDelaysMs;

  let config: string;
  try {
    config = fs.readFileSync(configPath, 'utf8');
  } catch {
    patch({ disabledReason: 'unconfigured' });
    return;
  }
  if (config.includes(PLACEHOLDER_OWNER)) {
    patch({ disabledReason: 'unconfigured' });
    return;
  }

  try {
    // Загрузка по требованию: сбой модуля обновлений не должен мешать запуску приложения
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.logger = createLogger();
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false; // выход из приложения и выключение Windows ничего не устанавливают
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.disableWebInstaller = true;
    if (test) {
      autoUpdater.forceDevUpdateConfig = true;
      autoUpdater.updateConfigPath = test.configPath;
    }
    autoUpdater.on('download-progress', (p: ProgressInfo) => {
      patch({ progress: { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond } });
    });
    autoUpdater.on('error', (err) => {
      // Ошибки проверки и загрузки разбираются в checkForUpdates, здесь остаётся сбой запуска установщика
      if (state.phase === 'installing') patch({ phase: 'downloaded', error: `Не удалось запустить установку: ${err.message}` });
    });
    updater = autoUpdater;
  } catch (err) {
    console.error('updater', err);
    patch({ disabledReason: 'failed' });
    return;
  }

  patch({ phase: 'idle', disabledReason: null, signatureRequired: /^publisherName:/m.test(config) });
  setTimeout(() => void checkForUpdates(false), firstCheckDelayMs);
  intervalTimer = setInterval(() => void checkForUpdates(false), CHECK_INTERVAL_MS);
  // Таймеры не идут во время сна компьютера
  powerMonitor.on('resume', () => {
    if (Date.now() - (state.lastCheckedAt ?? 0) >= CHECK_INTERVAL_MS) setTimeout(() => void checkForUpdates(false), firstCheckDelayMs);
  });
}
