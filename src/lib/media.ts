import { supabase } from './supabase';
import { safeFileName } from './format';
import type { Attachment, Scope } from './types';

export const MAX_ATTACHMENT = 25 * 1024 * 1024;
export const MAX_IMAGE = 5 * 1024 * 1024;
export const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const signedCache = new Map<string, { url: string; expires: number }>();
const inflight = new Map<string, Promise<string | null>>();

/** Подписанная ссылка на приватное вложение (доступ проверяется Storage RLS) */
export async function signedUrl(path: string): Promise<string | null> {
  const cached = signedCache.get(path);
  if (cached && cached.expires > Date.now() + 60_000) return cached.url;
  const existing = inflight.get(path);
  if (existing) return existing;
  const p = (async () => {
    const { data, error } = await supabase.storage.from('attachments').createSignedUrl(path, 3600);
    inflight.delete(path);
    if (error || !data) return null;
    signedCache.set(path, { url: data.signedUrl, expires: Date.now() + 3600_000 });
    return data.signedUrl;
  })();
  inflight.set(path, p);
  return p;
}

function imageSize(file: File): Promise<{ width: number; height: number } | null> {
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

export async function uploadAttachment(scope: Scope, userId: string, file: File): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT) throw new Error(`Файл «${file.name}» больше 25 МБ`);
  const folder = scope.kind === 'channel' ? 'channels' : 'dms';
  const path = `${folder}/${scope.id}/${userId}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
  const { error } = await supabase.storage.from('attachments').upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) throw error;
  const size = await imageSize(file);
  return {
    path,
    name: file.name.slice(0, 200),
    size: file.size,
    mime: file.type || 'application/octet-stream',
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
}

export async function removeAttachments(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await supabase.storage.from('attachments').remove(paths);
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
