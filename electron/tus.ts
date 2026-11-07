// Возобновляемая загрузка в Supabase Storage по протоколу TUS 1.0.
// Supabase требует части ровно по 6 МБ (кроме последней). Файл читается с диска по частям —
// в памяти одновременно не больше одной части. После обрыва загрузка продолжается с того байта,
// который сервер уже принял (HEAD → Upload-Offset).
import fs from 'node:fs';
import https from 'node:https';
import { URL } from 'node:url';

export const TUS_CHUNK = 6 * 1024 * 1024;
const WRITE_SLICE = 64 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

export class TusHttpError extends Error {
  constructor(public status: number, message: string, public retryable: boolean) {
    super(message);
  }
}

export interface TusTarget {
  endpoint: string;
  bucket: string;
  objectPath: string;
  contentType: string;
  accessToken: string;
  apiKey: string;
}

interface Resp {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function request(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Buffer | null,
  signal: AbortSignal,
  onWritten?: (n: number) => void,
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') {
      reject(new TusHttpError(0, 'Разрешены только защищённые соединения', false));
      return;
    }
    const req = https.request(
      { method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          if (chunks.length < 64) chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8').slice(0, 2000) }));
        res.on('error', reject);
      },
    );
    const abort = () => req.destroy(new Error('aborted'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => {
      signal.removeEventListener('abort', abort);
      reject(e);
    });
    req.on('close', () => signal.removeEventListener('abort', abort));
    if (!body) {
      req.end();
      return;
    }
    // Пишем кусками и ждём слива буфера — так прогресс отражает реально отправленные байты
    let pos = 0;
    const pump = () => {
      while (pos < body.length) {
        const slice = body.subarray(pos, Math.min(pos + WRITE_SLICE, body.length));
        pos += slice.length;
        const ok = req.write(slice, () => onWritten?.(slice.length));
        if (!ok) {
          req.once('drain', pump);
          return;
        }
      }
      req.end();
    };
    pump();
  });
}

function header(r: Resp, name: string): string | undefined {
  const v = r.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function errorFromResponse(r: Resp): TusHttpError {
  let msg = '';
  try {
    const j = JSON.parse(r.body) as { message?: string; error?: string };
    msg = j.message || j.error || '';
  } catch {
    msg = r.body.trim();
  }
  const retryable = r.status === 0 || r.status === 408 || r.status === 423 || r.status === 429 || r.status >= 500;
  if (r.status === 413) return new TusHttpError(413, 'Файл больше допустимого размера хранилища', false);
  if (r.status === 401) return new TusHttpError(401, 'Сессия истекла — войдите снова', false);
  if (r.status === 403) return new TusHttpError(403, msg ? `Хранилище отклонило загрузку: ${msg}` : 'Нет права загружать этот файл', false);
  if (r.status === 409 && /exists/i.test(msg)) return new TusHttpError(409, 'Файл с таким именем уже загружен', false);
  return new TusHttpError(r.status, msg || `Ошибка хранилища (${r.status})`, retryable);
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

function baseHeaders(t: TusTarget): Record<string, string> {
  return { 'Tus-Resumable': '1.0.0', authorization: `Bearer ${t.accessToken}`, apikey: t.apiKey };
}

/** Создать загрузку; возвращает URL загрузки для PATCH/HEAD */
export async function tusCreate(t: TusTarget, size: number, signal: AbortSignal): Promise<string> {
  const meta = [
    `bucketName ${b64(t.bucket)}`,
    `objectName ${b64(t.objectPath)}`,
    `contentType ${b64(t.contentType)}`,
    `cacheControl ${b64('3600')}`,
  ].join(',');
  const r = await request('POST', t.endpoint, { ...baseHeaders(t), 'Upload-Length': String(size), 'Upload-Metadata': meta, 'x-upsert': 'false', 'Content-Length': '0' }, null, signal);
  if (r.status !== 201) throw errorFromResponse(r);
  const loc = header(r, 'location');
  if (!loc) throw new TusHttpError(r.status, 'Сервер не вернул адрес загрузки', true);
  const url = new URL(loc, t.endpoint);
  // Адрес загрузки обязан быть на том же сервере
  if (url.host !== new URL(t.endpoint).host || url.protocol !== 'https:') throw new TusHttpError(0, 'Недопустимый адрес загрузки', false);
  return url.toString();
}

export async function tusOffset(t: TusTarget, uploadUrl: string, signal: AbortSignal): Promise<number> {
  const r = await request('HEAD', uploadUrl, baseHeaders(t), null, signal);
  if (r.status === 404 || r.status === 410) throw new TusHttpError(r.status, 'upload-expired', false);
  if (r.status !== 200 && r.status !== 204) throw errorFromResponse(r);
  const off = Number(header(r, 'upload-offset'));
  if (!Number.isFinite(off) || off < 0) throw new TusHttpError(r.status, 'Сервер не сообщил прогресс загрузки', true);
  return off;
}

/** Отправить файл, начиная с offset. onProgress — общее число принятых байт. */
export async function tusSend(
  t: TusTarget,
  uploadUrl: string,
  file: string,
  size: number,
  startOffset: number,
  signal: AbortSignal,
  onProgress: (sent: number) => void,
): Promise<void> {
  const fh = await fs.promises.open(file, 'r');
  try {
    let offset = startOffset;
    const buf = Buffer.alloc(Math.min(TUS_CHUNK, Math.max(size, 1)));
    while (offset < size) {
      if (signal.aborted) throw new Error('aborted');
      const len = Math.min(TUS_CHUNK, size - offset);
      const { bytesRead } = await fh.read(buf, 0, len, offset);
      if (bytesRead !== len) throw new TusHttpError(0, 'Файл изменился во время отправки', false);
      let inFlight = 0;
      const r = await request(
        'PATCH',
        uploadUrl,
        { ...baseHeaders(t), 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream', 'Content-Length': String(len) },
        buf.subarray(0, len),
        signal,
        (n) => {
          inFlight += n;
          onProgress(offset + Math.min(inFlight, len));
        },
      );
      if (r.status === 409) {
        // Смещение разошлось (например, после обрыва) — спросим сервер и продолжим оттуда
        offset = await tusOffset(t, uploadUrl, signal);
        onProgress(offset);
        continue;
      }
      if (r.status !== 204 && r.status !== 200) throw errorFromResponse(r);
      const next = Number(header(r, 'upload-offset'));
      offset = Number.isFinite(next) && next > offset ? next : offset + len;
      onProgress(offset);
    }
  } finally {
    await fh.close();
  }
}

export async function tusTerminate(t: TusTarget, uploadUrl: string): Promise<void> {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10_000);
  await request('DELETE', uploadUrl, { ...baseHeaders(t), 'Content-Length': '0' }, null, ac.signal).catch(() => undefined);
}

export function isNetworkError(e: unknown): boolean {
  if (e instanceof TusHttpError) return e.retryable;
  const code = (e as { code?: string })?.code ?? '';
  const msg = (e as Error)?.message ?? '';
  return /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|socket hang up|timeout/i.test(code + ' ' + msg);
}
