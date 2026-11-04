// Подпись манифеста обновлений (latest.yml) ключом Ed25519. Манифест содержит SHA-512 установщика,
// поэтому подпись подтверждает и сам файл. Приватный ключ есть только в секрете CI, публичные закреплены в приложении.
import crypto from 'node:crypto';

export const SIGNATURE_FIELD = 'rvSignature';

interface ManifestFile {
  url?: unknown;
  sha512?: unknown;
  size?: unknown;
}

export interface SignableManifest {
  version?: unknown;
  files?: unknown;
  releaseNotes?: unknown;
  packages?: unknown;
  isAdminRightsRequired?: unknown;
  rvSignature?: unknown;
}

/** Подписываемая часть манифеста: всё, что влияет на установку и текст для пользователя. null — манифест недопустим */
export function canonicalManifest(info: SignableManifest): string | null {
  if (typeof info.version !== 'string' || !Array.isArray(info.files) || info.files.length === 0) return null;
  if (info.packages != null) return null; // веб-установщик не используется
  const files: { url: string; sha512: string; size: number }[] = [];
  for (const file of info.files as ManifestFile[]) {
    if (typeof file.url !== 'string' || typeof file.sha512 !== 'string' || !file.sha512 || typeof file.size !== 'number') return null;
    files.push({ url: file.url, sha512: file.sha512, size: file.size });
  }
  return JSON.stringify({
    app: 'realism-voice',
    version: info.version,
    files,
    releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
    isAdminRightsRequired: info.isAdminRightsRequired === true,
  });
}

export function verifyManifest(info: SignableManifest, publicKeys: string[]): boolean {
  const canonical = canonicalManifest(info);
  if (canonical === null || typeof info.rvSignature !== 'string') return false;
  const signature = Buffer.from(info.rvSignature, 'base64');
  return publicKeys.some((key) => {
    try {
      const publicKey = crypto.createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
      return crypto.verify(null, Buffer.from(canonical), publicKey, signature);
    } catch {
      return false;
    }
  });
}
