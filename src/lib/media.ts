import { supabase, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase';
import { safeFileName } from './format';
import type { Attachment, Scope } from './types';

/** Лимит бесплатного тарифа Supabase Free на один файл. Фактическое значение приходит с сервера (app_limits). */
export const FREE_MAX_ATTACHMENT = 50 * 1024 * 1024;
/** Лимит до применения миграции 0009 (старый бакет — 25 МБ) */
const LEGACY_MAX_ATTACHMENT = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_IMAGE = 5 * 1024 * 1024;
export const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export interface AttachmentUsage {
  max_file: number;
  total_used: number;
  total_limit: number;
  user_used: number;
  user_limit: number;
  day_used: number;
  day_limit: number;
  month_download_used: number;
  month_download_limit: number;
}

let usageCache: { at: number; value: AttachmentUsage | null; v2: boolean } | null = null;

function isMissingFunction(err: { code?: string; message?: string } | null): boolean {
  return !!err && (err.code === 'PGRST202' || err.code === '42883' || /could not find the function/i.test(err.message ?? ''));
}

/** Квоты вложений; null — сервер ещё без миграции 0009 (тогда действуют старые правила) */
export async function attachmentUsage(force = false): Promise<{ usage: AttachmentUsage | null; v2: boolean }> {
  if (!force && usageCache && Date.now() - usageCache.at < 60_000) return { usage: usageCache.value, v2: usageCache.v2 };
  const { data, error } = await supabase.rpc('attachment_usage');
  if (error) {
    const v2 = !isMissingFunction(error);
    usageCache = { at: Date.now(), value: null, v2 };
    return { usage: null, v2 };
  }
  usageCache = { at: Date.now(), value: data as AttachmentUsage, v2: true };
  return { usage: data as AttachmentUsage, v2: true };
}

export async function maxAttachmentBytes(): Promise<number> {
  const { usage, v2 } = await attachmentUsage();
  if (usage?.max_file) return Number(usage.max_file);
  return v2 ? FREE_MAX_ATTACHMENT : LEGACY_MAX_ATTACHMENT;
}

/** Сервер выдаёт путь загрузки и проверяет права и квоты */
export async function reserveAttachment(scope: Scope, userId: string, name: string, size: number): Promise<{ path: string; maxBytes: number }> {
  const { data, error } = await supabase.rpc('reserve_attachment', {
    p_scope_kind: scope.kind,
    p_scope_id: scope.id,
    p_name: name,
    p_size: size,
  });
  if (error) {
    if (isMissingFunction(error)) {
      // Сервер без миграции 0009: прежняя схема путей и лимит 25 МБ
      if (size > LEGACY_MAX_ATTACHMENT) throw new Error(`«${name}» больше 25 МБ`);
      const folder = scope.kind === 'channel' ? 'channels' : 'dms';
      return { path: `${folder}/${scope.id}/${userId}/${crypto.randomUUID()}-${safeFileName(name)}`, maxBytes: LEGACY_MAX_ATTACHMENT };
    }
    throw new Error(error.message);
  }
  const row = (Array.isArray(data) ? data[0] : data) as { path: string; max_bytes: number };
  usageCache = null;
  return { path: row.path, maxBytes: Number(row.max_bytes) };
}

export function tusEndpoint(): string {
  return `${SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/upload/resumable`;
}

export async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Сессия истекла — войдите снова');
  return token;
}

export function publishableKey(): string {
  return SUPABASE_PUBLISHABLE_KEY;
}

/** Загрузка данных из буфера обмена (небольшие изображения) стандартным способом */
export async function uploadBlob(path: string, blob: Blob, contentType: string): Promise<void> {
  const { error } = await supabase.storage.from('attachments').upload(path, blob, { contentType, upsert: false });
  if (error) throw new Error(error.message);
}

const signedCache = new Map<string, { url: string; expires: number }>();
const inflight = new Map<string, Promise<string | null>>();

/**
 * Учёт скачивания на сервере (бережёт месячный трафик бесплатного тарифа) и подписанная ссылка.
 * Ссылка временная (10 минут); доступ проверяет Storage RLS.
 */
export async function requestDownload(path: string): Promise<void> {
  const { error } = await supabase.rpc('request_attachment_download', { p_path: path });
  if (error && !isMissingFunction(error)) throw new Error(error.message);
}

/**
 * Срок подписанной ссылки. Ссылкой можно пользоваться повторно, пока она действует, поэтому срок
 * короткий: скачивание и превью начинаются сразу. Видео дольше — плеер дозагружает его частями.
 */
export const SIGNED_URL_TTL = { download: 120, preview: 120, video: 900 } as const;

export async function signedUrl(path: string, opts: { count?: boolean; ttl?: number } = {}): Promise<string | null> {
  const ttl = opts.ttl ?? SIGNED_URL_TTL.download;
  const key = `${path}|${ttl}`;
  const cached = signedCache.get(key);
  if (cached && cached.expires > Date.now() + 30_000) return cached.url;
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      if (opts.count !== false) await requestDownload(path);
      const { data, error } = await supabase.storage.from('attachments').createSignedUrl(path, ttl);
      if (error || !data) return null;
      signedCache.set(key, { url: data.signedUrl, expires: Date.now() + ttl * 1000 });
      return data.signedUrl;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function imageSize(file: Blob): Promise<{ width: number; height: number } | null> {
  if (!file.type.startsWith('image/')) return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

export async function removeAttachments(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await supabase.storage.from('attachments').remove(paths);
}

/** Удалить собственные брошенные загрузки (отменённые, прерванные, из удалённых сообщений) */
export async function cleanupStaleUploads(): Promise<number> {
  const { data, error } = await supabase.rpc('my_stale_uploads');
  if (error || !Array.isArray(data) || data.length === 0) return 0;
  const paths = (data as { path: string }[]).map((r) => r.path).filter(Boolean);
  await removeAttachments(paths).catch(() => undefined);
  usageCache = null;
  return paths.length;
}

export async function uploadPublicImage(bucket: 'avatars' | 'server-icons' | 'profile-banners', folder: string, file: File): Promise<string> {
  if (!IMAGE_MIME.includes(file.type)) throw new Error('Поддерживаются PNG, JPEG, GIF и WebP');
  if (file.size > MAX_IMAGE) throw new Error('Изображение должно быть не больше 5 МБ');
  const ext = file.type.split('/')[1].replace('jpeg', 'jpg');
  const path = `${folder}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return path;
}

export type { Attachment };
