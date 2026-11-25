// Шифрование локальной P2P-истории на диске (IndexedDB).
// Ключ AES-256-GCM случайный и хранится в защищённом хранилище приложения (Windows DPAPI — привязка
// к учётной записи Windows), как и токены сессии. Без него файлы IndexedDB из профиля прочитать нельзя.
import { fromB64, toB64 } from './crypto';

const STORAGE_KEY = 'rv-p2p-vault-v1';
const enc = new TextEncoder();
const dec = new TextDecoder();

let key: Promise<CryptoKey> | null = null;

async function importRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export function vaultKey(): Promise<CryptoKey> {
  key ??= (async () => {
    const store = typeof window !== 'undefined' ? window.rv?.storage : undefined;
    const saved = store ? await store.getItem(STORAGE_KEY) : null;
    if (saved) {
      const raw = fromB64(saved);
      if (raw.length === 32) return importRaw(raw);
    }
    const raw = crypto.getRandomValues(new Uint8Array(32));
    // Вне приложения (отладка в браузере) ключ живёт только в памяти: история не переживёт перезапуск
    if (store) await store.setItem(STORAGE_KEY, toB64(raw));
    const k = await importRaw(raw);
    raw.fill(0);
    return k;
  })();
  return key;
}

/** Зашифровать объект: base64(iv 12 байт || шифротекст с тегом); aad привязывает запись к её ключу в базе */
export async function sealJson(k: CryptoKey, obj: unknown, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(aad) as BufferSource }, k, enc.encode(JSON.stringify(obj)) as BufferSource),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return toB64(out);
}

export async function openJson<T>(k: CryptoKey, sealed: string, aad: string): Promise<T> {
  const buf = fromB64(sealed);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf.subarray(0, 12) as BufferSource, additionalData: enc.encode(aad) as BufferSource },
    k,
    buf.subarray(12) as BufferSource,
  );
  return JSON.parse(dec.decode(plain)) as T;
}
