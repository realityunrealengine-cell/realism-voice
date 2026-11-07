// Передача файлов и папок: выбор, упаковка папки в ZIP, возобновляемая загрузка (TUS),
// скачивание с прогрессом и безопасная распаковка папок.
//
// Безопасность:
//   * пути к файлам остаются в main-процессе; интерфейс получает только непрозрачные токены;
//     зарегистрировать можно лишь то, что пользователь выбрал в системном окне или перетащил;
//   * загрузка идёт только по https на адрес TUS Supabase Storage в бакет attachments;
//   * скачанные файлы получают отметку «из интернета» (Zone.Identifier), поэтому Windows SmartScreen
//     проверяет EXE при запуске; приложение само ничего не открывает и не запускает;
//   * распаковка папок защищена от выхода за пределы папки назначения (zip-slip) и zip-бомб.
import { app, BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent, net, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import type { DownloadProgress, DownloadRequest, PickedItem, TransferProgress, UploadRequest } from './shared';
import { ArchiveTooLargeError, FolderLimitError, MAX_FOLDER_BYTES, extractZip, readZipIndex, scanFolder, zipFolder } from './zip';
import { isNetworkError, TusHttpError, tusCreate, tusOffset, tusSend, tusTerminate, type TusTarget } from './tus';
import { isDangerousFile } from './fileRisk';
import { sanitizeSegment } from './zipPaths';

/** Абсолютный предел одного файла в клиенте; фактический лимит приходит с сервера (app_limits) */
const HARD_MAX_FILE = 500 * 1024 * 1024 * 1024;
const OBJECT_PATH_RE = /^(channels|dms)\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[^/\\]{1,200}$/i;
const NETWORK_RETRY_MS = [2000, 4000, 8000, 15000, 30000, 30000, 60000, 60000, 60000];

interface Registered {
  path: string;
  kind: 'file' | 'folder';
  name: string;
  size: number;
  files?: number;
  dirs?: number;
}

interface UploadJob {
  id: string;
  token: string;
  file: string;
  size: number;
  contentType: string;
  tempZip: string | null;
  uploadUrl: string | null;
  target: TusTarget | null;
  ac: AbortController | null;
  sent: number;
  running: Promise<void> | null;
}

const registry = new Map<string, Registered>();
const jobs = new Map<string, UploadJob>();
const downloads = new Map<string, AbortController>();
const savedPaths = new Set<string>();

type Sender = (channel: string, payload: unknown) => void;
let send: Sender = () => undefined;
type Guard = (e: IpcMainInvokeEvent) => boolean;

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', gz: 'application/gzip', tar: 'application/x-tar',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  exe: 'application/vnd.microsoft.portable-executable', msi: 'application/x-msi',
};

function contentTypeFor(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  // SVG и HTML отдаём как двоичные данные: подписанная ссылка не должна исполнять разметку
  if (ext === 'svg' || ext === 'html' || ext === 'htm' || ext === 'xhtml') return 'application/octet-stream';
  return MIME[ext] ?? 'application/octet-stream';
}

function tempDir(): string {
  const dir = path.join(app.getPath('temp'), 'realism-voice-transfers');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function freeSpace(dir: string): Promise<number> {
  try {
    const s = await fs.promises.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

async function markFromInternet(p: string, referrer?: string) {
  if (process.platform !== 'win32') return;
  const host = referrer ? new URL(referrer).origin : '';
  await fs.promises
    .writeFile(`${p}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\n${host ? `HostUrl=${host}\r\n` : ''}`)
    .catch(() => undefined);
}

async function registerPath(p: string): Promise<PickedItem | null> {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(p);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) {
    // Ярлык-ссылка: отправляем то, на что он указывает, только если это обычный файл или папка
    try {
      st = await fs.promises.stat(p);
    } catch {
      return null;
    }
  }
  const token = crypto.randomUUID();
  const name = path.basename(p);
  if (st.isFile()) {
    registry.set(token, { path: p, kind: 'file', name, size: st.size });
    return { token, kind: 'file', name, size: st.size, error: st.size === 0 ? 'Пустой файл' : st.size > HARD_MAX_FILE ? 'Файл слишком большой' : null };
  }
  if (st.isDirectory()) {
    try {
      const scan = await scanFolder(p);
      registry.set(token, { path: p, kind: 'folder', name, size: scan.bytes, files: scan.files, dirs: scan.dirs });
      return {
        token, kind: 'folder', name, size: scan.bytes, files: scan.files, dirs: scan.dirs,
        error: scan.files === 0 && scan.dirs === 0 ? 'Папка пустая' : null,
      };
    } catch (e) {
      const msg = e instanceof FolderLimitError ? e.message : 'Не удалось прочитать папку';
      return { token, kind: 'folder', name, size: 0, error: msg };
    }
  }
  return null;
}

function emitUpload(p: TransferProgress) {
  send('files:upload-progress', p);
}

function emitDownload(p: DownloadProgress) {
  send('files:download-progress', p);
}

function validateUpload(req: UploadRequest): string | null {
  if (!req || typeof req.id !== 'string' || typeof req.token !== 'string') return 'Некорректный запрос';
  try {
    const u = new URL(req.endpoint);
    if (u.protocol !== 'https:' || !u.pathname.endsWith('/storage/v1/upload/resumable')) return 'Недопустимый адрес хранилища';
  } catch {
    return 'Недопустимый адрес хранилища';
  }
  if (req.bucket !== 'attachments') return 'Недопустимое хранилище';
  if (!OBJECT_PATH_RE.test(req.objectPath) || req.objectPath.includes('..')) return 'Недопустимый путь файла';
  if (typeof req.accessToken !== 'string' || req.accessToken.length < 20 || typeof req.apiKey !== 'string') return 'Нет авторизации';
  if (typeof req.maxBytes !== 'number' || req.maxBytes <= 0) return 'Некорректный лимит';
  return null;
}

/** Подготовка: проверка файла или упаковка папки. Возвращает размер того, что будет отправлено. */
async function prepare(id: string, token: string, maxBytes: number): Promise<{ size: number; contentType: string }> {
  const item = registry.get(token);
  if (!item) throw new Error('Файл больше недоступен — прикрепите его снова');
  const existing = jobs.get(id);
  if (existing) return { size: existing.size, contentType: existing.contentType };

  if (item.kind === 'file') {
    const st = await fs.promises.stat(item.path).catch(() => null);
    if (!st || !st.isFile()) throw new Error(`Файл «${item.name}» не найден`);
    if (st.size === 0) throw new Error(`Файл «${item.name}» пустой`);
    if (st.size > maxBytes) throw new Error(`Файл «${item.name}» больше ${Math.floor(maxBytes / 1048576)} МБ`);
    const job: UploadJob = { id, token, file: item.path, size: st.size, contentType: contentTypeFor(item.name), tempZip: null, uploadUrl: null, target: null, ac: null, sent: 0, running: null };
    jobs.set(id, job);
    return { size: job.size, contentType: job.contentType };
  }

  // Папка → ZIP во временной папке, потоково, с прерыванием при превышении лимита
  const ac = new AbortController();
  downloads.set(`prep:${id}`, ac);
  const out = path.join(tempDir(), `${id}.zip`);
  try {
    if ((await freeSpace(tempDir())) < Math.min(item.size, maxBytes) + 64 * 1024 * 1024) {
      throw new Error('Недостаточно места на диске для подготовки папки');
    }
    emitUpload({ id, phase: 'preparing', transferred: 0, total: 0, bytesPerSecond: 0, packedFiles: 0, totalFiles: item.files ?? 0 });
    const scan = await scanFolder(item.path, ac.signal);
    if (scan.bytes > MAX_FOLDER_BYTES) throw new FolderLimitError('Папка больше 1 ГБ до сжатия');
    let lastEmit = 0;
    const { size } = await zipFolder(scan, out, maxBytes, (packed, total) => {
      const now = Date.now();
      if (now - lastEmit > 150 || packed === total) {
        lastEmit = now;
        emitUpload({ id, phase: 'preparing', transferred: 0, total: 0, bytesPerSecond: 0, packedFiles: packed, totalFiles: total });
      }
    }, ac.signal);
    const job: UploadJob = { id, token, file: out, size, contentType: 'application/zip', tempZip: out, uploadUrl: null, target: null, ac: null, sent: 0, running: null };
    jobs.set(id, job);
    return { size, contentType: 'application/zip' };
  } catch (e) {
    await fs.promises.rm(out, { force: true }).catch(() => undefined);
    if (e instanceof ArchiveTooLargeError) throw new Error(`Папка «${item.name}» после сжатия больше ${Math.floor(maxBytes / 1048576)} МБ`);
    if ((e as Error)?.message === 'cancelled' || ac.signal.aborted) throw new Error('cancelled');
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    downloads.delete(`prep:${id}`);
  }
}

async function runUpload(job: UploadJob, req: UploadRequest): Promise<void> {
  job.target = { endpoint: req.endpoint, bucket: req.bucket, objectPath: req.objectPath, contentType: job.contentType, accessToken: req.accessToken, apiKey: req.apiKey };
  const ac = new AbortController();
  job.ac = ac;
  let speedBase = { t: Date.now(), bytes: job.sent };
  let bps = 0;
  let lastEmit = 0;
  const progress = (sent: number) => {
    job.sent = sent;
    const now = Date.now();
    if (now - speedBase.t >= 1000) {
      bps = Math.round(((sent - speedBase.bytes) * 1000) / (now - speedBase.t));
      speedBase = { t: now, bytes: sent };
    }
    if (now - lastEmit > 120 || sent >= job.size) {
      lastEmit = now;
      emitUpload({ id: job.id, phase: 'uploading', transferred: sent, total: job.size, bytesPerSecond: Math.max(0, bps) });
    }
  };

  let attempt = 0;
  for (;;) {
    try {
      if (!job.uploadUrl) {
        job.uploadUrl = await tusCreate(job.target, job.size, ac.signal);
        job.sent = 0;
      } else {
        try {
          job.sent = await tusOffset(job.target, job.uploadUrl, ac.signal);
        } catch (e) {
          if (e instanceof TusHttpError && e.message === 'upload-expired') {
            job.uploadUrl = null;
            continue;
          }
          throw e;
        }
      }
      progress(job.sent);
      await tusSend(job.target, job.uploadUrl, job.file, job.size, job.sent, ac.signal, progress);
      emitUpload({ id: job.id, phase: 'done', transferred: job.size, total: job.size, bytesPerSecond: bps, result: { size: job.size, contentType: job.contentType, sha256: '' } });
      return;
    } catch (e) {
      if (ac.signal.aborted) throw e;
      if (!isNetworkError(e) || attempt >= NETWORK_RETRY_MS.length) throw e;
      // Обрыв сети: ждём и продолжаем с того места, где сервер остановился
      emitUpload({ id: job.id, phase: 'waiting-network', transferred: job.sent, total: job.size, bytesPerSecond: 0, error: 'Нет соединения — загрузка продолжится автоматически' });
      const delay = NETWORK_RETRY_MS[attempt++];
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        ac.signal.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
      if (ac.signal.aborted) throw new Error('aborted');
      // Пока Windows сообщает, что сети нет, попытку не тратим
      if (!net.isOnline()) attempt = Math.max(0, attempt - 1);
    }
  }
}

async function cleanupJob(job: UploadJob, terminate: boolean) {
  jobs.delete(job.id);
  if (terminate && job.uploadUrl && job.target) await tusTerminate(job.target, job.uploadUrl);
  if (job.tempZip) await fs.promises.rm(job.tempZip, { force: true }).catch(() => undefined);
}

// ---------- Скачивание ----------

function httpsGet(url: string, signal: AbortSignal, redirects = 0): Promise<import('node:http').IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') {
      reject(new Error('Разрешены только защищённые ссылки'));
      return;
    }
    const req = https.get(u, { timeout: 60_000 }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location && redirects < 5) {
        res.resume();
        resolve(httpsGet(new URL(res.headers.location, u).toString(), signal, redirects + 1));
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error(code === 400 || code === 403 || code === 404 ? 'Ссылка на файл устарела или файл удалён' : `Ошибка сервера (${code})`));
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
  });
}

async function downloadTo(req: DownloadRequest, dest: string, ac: AbortController): Promise<void> {
  const part = `${dest}.part`;
  const res = await httpsGet(req.url, ac.signal);
  const total = Number(res.headers['content-length']) || req.size || 0;
  const limit = Math.max(req.size, total) + 1024 * 1024;
  let got = 0;
  let base = { t: Date.now(), b: 0 };
  let bps = 0;
  let lastEmit = 0;
  const out = fs.createWriteStream(part, { flags: 'w' });
  try {
    await new Promise<void>((resolve, reject) => {
      res.on('data', (chunk: Buffer) => {
        got += chunk.length;
        if (got > limit) {
          res.destroy(new Error('Размер файла не совпадает'));
          return;
        }
        if (!out.write(chunk)) {
          res.pause();
          out.once('drain', () => res.resume());
        }
        const now = Date.now();
        if (now - base.t >= 1000) {
          bps = Math.round(((got - base.b) * 1000) / (now - base.t));
          base = { t: now, b: got };
        }
        if (now - lastEmit > 120) {
          lastEmit = now;
          emitDownload({ id: req.id, phase: 'downloading', transferred: got, total, bytesPerSecond: bps });
        }
      });
      res.on('end', () => out.end(() => resolve()));
      res.on('error', reject);
      out.on('error', reject);
    });
    if (total && got !== total) throw new Error('Загрузка прервалась — попробуйте ещё раз');
    await fs.promises.rename(part, dest);
  } catch (e) {
    out.destroy();
    await fs.promises.rm(part, { force: true }).catch(() => undefined);
    throw e;
  }
}

async function runDownload(win: BrowserWindow | null, req: DownloadRequest): Promise<void> {
  const ac = new AbortController();
  downloads.set(req.id, ac);
  const safeName = sanitizeSegment(req.name) || 'file';
  try {
    emitDownload({ id: req.id, phase: 'choosing', transferred: 0, total: req.size, bytesPerSecond: 0 });
    if (req.extractFolder) {
      const pick = win
        ? await dialog.showOpenDialog(win, { title: `Куда сохранить папку «${safeName}»`, properties: ['openDirectory', 'createDirectory'], defaultPath: app.getPath('downloads') })
        : { canceled: true, filePaths: [] };
      if (pick.canceled || !pick.filePaths[0]) {
        emitDownload({ id: req.id, phase: 'cancelled', transferred: 0, total: req.size, bytesPerSecond: 0 });
        return;
      }
      const parent = pick.filePaths[0];
      const tmp = path.join(tempDir(), `${req.id}.zip`);
      if ((await freeSpace(tempDir())) < req.size * 2 + 64 * 1024 * 1024) throw new Error('Недостаточно места на диске');
      await downloadTo(req, tmp, ac);
      try {
        emitDownload({ id: req.id, phase: 'extracting', transferred: 0, total: 0, bytesPerSecond: 0 });
        let lastEmit = 0;
        const need = (await readZipIndex(tmp)).reduce((a, e) => a + e.usize, 0);
        if ((await freeSpace(parent)) < need + 16 * 1024 * 1024) throw new Error('Недостаточно места на диске для распаковки папки');
        const result = await extractZip(
          tmp,
          parent,
          safeName.replace(/\.zip$/i, ''),
          { maxBytes: MAX_FOLDER_BYTES },
          (done, total) => {
            const now = Date.now();
            if (now - lastEmit > 120) {
              lastEmit = now;
              emitDownload({ id: req.id, phase: 'extracting', transferred: done, total, bytesPerSecond: 0 });
            }
          },
          (p) => markFromInternet(p, req.url),
          ac.signal,
        );
        savedPaths.add(result.folder);
        emitDownload({
          id: req.id, phase: 'done', transferred: req.size, total: req.size, bytesPerSecond: 0, savedPath: result.folder,
          error: result.skipped ? `Пропущено небезопасных или существующих записей: ${result.skipped}` : null,
        });
      } finally {
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      }
      return;
    }

    const pick = win
      ? await dialog.showSaveDialog(win, { title: 'Сохранить файл', defaultPath: path.join(app.getPath('downloads'), safeName) })
      : { canceled: true, filePath: undefined };
    if (pick.canceled || !pick.filePath) {
      emitDownload({ id: req.id, phase: 'cancelled', transferred: 0, total: req.size, bytesPerSecond: 0 });
      return;
    }
    const dest = pick.filePath;
    if ((await freeSpace(path.dirname(dest))) < req.size + 16 * 1024 * 1024) throw new Error('Недостаточно места на диске');
    await downloadTo(req, dest, ac);
    await markFromInternet(dest, req.url);
    savedPaths.add(dest);
    emitDownload({ id: req.id, phase: 'done', transferred: req.size, total: req.size, bytesPerSecond: 0, savedPath: dest });
  } catch (e) {
    const cancelled = ac.signal.aborted;
    emitDownload({
      id: req.id, phase: cancelled ? 'cancelled' : 'error', transferred: 0, total: req.size, bytesPerSecond: 0,
      error: cancelled ? null : (e as Error)?.message ?? 'Ошибка скачивания',
    });
  } finally {
    downloads.delete(req.id);
  }
}

// ---------- IPC ----------

export function setupTransfers(getWindow: () => BrowserWindow | null, assertSender: Guard) {
  send = (channel, payload) => getWindow()?.webContents.send(channel, payload);

  ipcMain.handle('files:pick', async (e) => {
    if (!assertSender(e)) return [];
    const win = getWindow();
    if (!win) return [];
    const r = await dialog.showOpenDialog(win, { title: 'Отправить файлы', properties: ['openFile', 'multiSelections', 'dontAddToRecent'] });
    if (r.canceled) return [];
    const out: PickedItem[] = [];
    for (const p of r.filePaths.slice(0, 10)) {
      const it = await registerPath(p);
      if (it) out.push(it);
    }
    return out;
  });

  ipcMain.handle('files:pick-folder', async (e) => {
    if (!assertSender(e)) return null;
    const win = getWindow();
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { title: 'Отправить папку', properties: ['openDirectory', 'dontAddToRecent'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return registerPath(r.filePaths[0]);
  });

  // Пути перетащенных файлов получает preload (webUtils.getPathForFile) из настоящих объектов File
  ipcMain.handle('files:register-dropped', async (e, paths: unknown) => {
    if (!assertSender(e) || !Array.isArray(paths)) return [];
    const out: PickedItem[] = [];
    for (const p of paths.slice(0, 10)) {
      if (typeof p !== 'string' || !p) continue;
      const it = await registerPath(p);
      if (it) out.push(it);
    }
    return out;
  });

  ipcMain.handle('files:release', async (e, tokens: unknown) => {
    if (!assertSender(e) || !Array.isArray(tokens)) return;
    for (const t of tokens) if (typeof t === 'string') registry.delete(t);
  });

  ipcMain.handle('files:prepare', async (e, id: unknown, token: unknown, maxBytes: unknown) => {
    if (!assertSender(e) || typeof id !== 'string' || typeof token !== 'string' || typeof maxBytes !== 'number') throw new Error('Некорректный запрос');
    return prepare(id, token, Math.min(maxBytes, HARD_MAX_FILE));
  });

  ipcMain.handle('files:upload', async (e, req: UploadRequest) => {
    if (!assertSender(e)) throw new Error('Отказано');
    const err = validateUpload(req);
    if (err) throw new Error(err);
    const job = jobs.get(req.id);
    if (!job || job.token !== req.token) throw new Error('Файл не подготовлен — отправьте его заново');
    if (job.size > req.maxBytes) throw new Error('Файл больше допустимого размера');
    if (job.running) return job.running;
    job.running = runUpload(job, req)
      .then(async () => {
        await cleanupJob(job, false);
        registry.delete(job.token);
      })
      .catch((err2) => {
        const aborted = job.ac?.signal.aborted;
        const reason = job.ac?.signal.reason;
        job.running = null;
        if (aborted && reason === 'pause') {
          emitUpload({ id: job.id, phase: 'paused', transferred: job.sent, total: job.size, bytesPerSecond: 0 });
          throw new Error('paused');
        }
        if (aborted) throw new Error('cancelled');
        const msg = (err2 as Error)?.message || 'Ошибка загрузки';
        emitUpload({ id: job.id, phase: 'error', transferred: job.sent, total: job.size, bytesPerSecond: 0, error: msg });
        throw new Error(msg);
      });
    return job.running;
  });

  ipcMain.handle('files:pause', async (e, id: unknown) => {
    if (!assertSender(e) || typeof id !== 'string') return;
    jobs.get(id)?.ac?.abort('pause');
  });

  ipcMain.handle('files:cancel', async (e, id: unknown) => {
    if (!assertSender(e) || typeof id !== 'string') return;
    downloads.get(`prep:${id}`)?.abort('cancel');
    const job = jobs.get(id);
    if (!job) return;
    job.ac?.abort('cancel');
    await job.running?.catch(() => undefined);
    await cleanupJob(job, true);
    emitUpload({ id, phase: 'cancelled', transferred: 0, total: job.size, bytesPerSecond: 0 });
  });

  ipcMain.handle('files:download', async (e, req: DownloadRequest) => {
    if (!assertSender(e) || !req || typeof req.id !== 'string' || typeof req.url !== 'string' || typeof req.name !== 'string') return;
    try {
      if (new URL(req.url).protocol !== 'https:') return;
    } catch {
      return;
    }
    if (downloads.has(req.id)) return;
    void runDownload(getWindow(), { ...req, size: Number(req.size) || 0, extractFolder: req.extractFolder === true });
  });

  ipcMain.handle('files:cancel-download', async (e, id: unknown) => {
    if (!assertSender(e) || typeof id !== 'string') return;
    downloads.get(id)?.abort('cancel');
  });

  ipcMain.handle('files:show', async (e, p: unknown) => {
    if (!assertSender(e) || typeof p !== 'string' || !savedPaths.has(p)) return;
    shell.showItemInFolder(p);
  });

  ipcMain.handle('files:open', async (e, p: unknown, confirmed: unknown) => {
    if (!assertSender(e) || typeof p !== 'string' || !savedPaths.has(p)) return 'missing';
    if (!fs.existsSync(p)) return 'missing';
    const isDir = fs.statSync(p).isDirectory();
    if (!isDir && isDangerousFile(p) && confirmed !== true) return 'needs-confirmation';
    if (isDir) shell.showItemInFolder(p);
    else await shell.openPath(p);
    return 'opened';
  });

  // Временные архивы прошлых запусков
  app.on('will-quit', () => {
    try {
      fs.rmSync(path.join(app.getPath('temp'), 'realism-voice-transfers'), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
}
