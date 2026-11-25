// Долговременный ключ устройства для P2P: подпись обмена ключами и «коды безопасности».
//
// Без него подлинность собеседника в P2P-канале подтверждает только сервер сигнализации: теоретически
// сервер мог бы встать посередине. Теперь каждое устройство подписывает свой обмен ключами гибридной
// подписью Ed25519 + ML-DSA-65 (FIPS 204, @noble/post-quantum и @noble/curves — проверенные реализации,
// своих алгоритмов нет). Подпись принимается, только если верны ОБЕ части.
//
//   * Ключ создаётся один раз и хранится как два 32-байтных зерна в защищённом хранилище приложения
//     (Windows DPAPI, тот же механизм, что хранит сессию).
//   * Собеседник запоминает ключ при первой встрече (TOFU, см. trust.ts); смена ключа видна и вызывает
//     предупреждение; совпадение можно проверить вручную по 60-значному коду безопасности.
import { ed25519 } from '@noble/curves/ed25519.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { fromB64, toB64 } from './crypto';

const enc = new TextEncoder();
const CONTEXT = enc.encode('rv-p2p-id-v1');
const STORAGE_KEY = 'rv-device-identity-v1';

export interface DeviceIdentity {
  edSecret: Uint8Array;
  edPublic: Uint8Array;
  pqSecret: Uint8Array;
  pqPublic: Uint8Array;
}

export interface PublicIdentity {
  ed: Uint8Array;
  pq: Uint8Array;
}

export interface HybridSignature {
  ed: Uint8Array;
  pq: Uint8Array;
}

export function identityFromSeeds(edSeed: Uint8Array, pqSeed: Uint8Array): DeviceIdentity {
  if (edSeed.length !== 32 || pqSeed.length !== 32) throw new Error('bad seed');
  const pq = ml_dsa65.keygen(pqSeed);
  return { edSecret: edSeed, edPublic: ed25519.getPublicKey(edSeed), pqSecret: pq.secretKey, pqPublic: pq.publicKey };
}

export function newIdentity(): { id: DeviceIdentity; seeds: { ed: string; pq: string } } {
  const ed = crypto.getRandomValues(new Uint8Array(32));
  const pq = crypto.getRandomValues(new Uint8Array(32));
  return { id: identityFromSeeds(ed, pq), seeds: { ed: toB64(ed), pq: toB64(pq) } };
}

export function publicOf(id: DeviceIdentity): PublicIdentity {
  return { ed: id.edPublic, pq: id.pqPublic };
}

export function signHybrid(id: DeviceIdentity, msg: Uint8Array): HybridSignature {
  return { ed: ed25519.sign(msg, id.edSecret), pq: ml_dsa65.sign(msg, id.pqSecret, { context: CONTEXT }) };
}

/** Обе подписи обязаны быть верны (гибрид: стойкость сохраняется, пока не взломаны ОБА алгоритма) */
export function verifyHybrid(pub: PublicIdentity, msg: Uint8Array, sig: HybridSignature): boolean {
  try {
    if (pub.ed.length !== 32 || pub.pq.length !== ml_dsa65.lengths.publicKey) return false;
    return ed25519.verify(sig.ed, msg, pub.ed) && ml_dsa65.verify(sig.pq, msg, pub.pq, { context: CONTEXT });
  } catch {
    return false;
  }
}

/** Короткий отпечаток открытого ключа (hex) — идентификатор устройства в списке доверия */
export function fingerprint(pub: PublicIdentity): string {
  const h = sha256(new Uint8Array([...pub.ed, ...pub.pq]));
  return [...h.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 30 цифр, описывающих ключ пользователя (как «номер безопасности» в Signal: итерации SHA-512) */
function digitsFor(userId: string, pub: PublicIdentity): string {
  let h = sha512(new Uint8Array([...enc.encode(`rv-safety-v1|${userId}|`), ...pub.ed, ...pub.pq]));
  for (let i = 0; i < 1024; i++) h = sha512(new Uint8Array([...h, ...pub.ed]));
  let out = '';
  for (let i = 0; i < 6; i++) {
    const n = ((h[i * 5] * 2 ** 32 + ((h[i * 5 + 1] << 24) >>> 0) + (h[i * 5 + 2] << 16) + (h[i * 5 + 3] << 8) + h[i * 5 + 4]) % 100000);
    out += String(n).padStart(5, '0');
  }
  return out;
}

/**
 * Код безопасности пары «я ↔ собеседник»: 60 цифр, одинаковые у обоих (части упорядочены по id).
 * Совпадает — значит, между вами нет посредника.
 */
export function safetyCode(a: { userId: string; pub: PublicIdentity }, b: { userId: string; pub: PublicIdentity }): string {
  const [x, y] = [a, b].sort((p, q) => p.userId.localeCompare(q.userId));
  const digits = digitsFor(x.userId, x.pub) + digitsFor(y.userId, y.pub);
  return digits.match(/.{5}/g)!.join(' ');
}

export function encodePublic(pub: PublicIdentity): { ed: string; pq: string } {
  return { ed: toB64(pub.ed), pq: toB64(pub.pq) };
}

export function decodePublic(v: unknown): PublicIdentity | null {
  const o = v as { ed?: unknown; pq?: unknown } | null;
  if (!o || typeof o.ed !== 'string' || typeof o.pq !== 'string' || o.ed.length > 64 || o.pq.length > 4096) return null;
  try {
    const pub = { ed: fromB64(o.ed), pq: fromB64(o.pq) };
    return pub.ed.length === 32 && pub.pq.length === ml_dsa65.lengths.publicKey ? pub : null;
  } catch {
    return null;
  }
}

export function encodeSig(s: HybridSignature): { ed: string; pq: string } {
  return { ed: toB64(s.ed), pq: toB64(s.pq) };
}

export function decodeSig(v: unknown): HybridSignature | null {
  const o = v as { ed?: unknown; pq?: unknown } | null;
  if (!o || typeof o.ed !== 'string' || typeof o.pq !== 'string' || o.ed.length > 128 || o.pq.length > 8192) return null;
  try {
    return { ed: fromB64(o.ed), pq: fromB64(o.pq) };
  } catch {
    return null;
  }
}

let loaded: Promise<DeviceIdentity> | null = null;

/** Ключ этого устройства: из защищённого хранилища или новый (сохраняется сразу) */
export function deviceIdentity(): Promise<DeviceIdentity> {
  loaded ??= (async () => {
    const store = typeof window !== 'undefined' ? window.rv?.storage : undefined;
    const raw = store ? await store.getItem(STORAGE_KEY) : localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const s = JSON.parse(raw) as { ed: string; pq: string };
        return identityFromSeeds(fromB64(s.ed), fromB64(s.pq));
      } catch {
        /* повреждено — создаём новый ключ */
      }
    }
    const { id, seeds } = newIdentity();
    const value = JSON.stringify(seeds);
    // Вне приложения (отладка в браузере) защищённого хранилища нет
    if (store) await store.setItem(STORAGE_KEY, value);
    else localStorage.setItem(STORAGE_KEY, value);
    return id;
  })();
  return loaded;
}
