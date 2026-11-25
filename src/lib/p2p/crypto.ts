// Сквозное шифрование прямого (P2P) канала сообщений поверх DTLS WebRTC.
//
// Зачем ещё один слой, если DataChannel уже шифруется DTLS: обмен ключами DTLS классический (ECDHE),
// и записанный сегодня трафик в будущем может быть расшифрован квантовым компьютером
// («harvest now, decrypt later»). Поэтому поверх DTLS устанавливается гибридный ключ:
//
//   X-Wing = X25519 + ML-KEM-768 (FIPS 203), готовая реализация @noble/post-quantum (ml_kem768_x25519,
//   draft-connolly-cfrg-xwing-kem). Свои криптографические примитивы здесь не создаются — только
//   стандартная композиция: KEM → HKDF-SHA-256 → AES-256-GCM (WebCrypto).
//
// Свойства:
//   * секретность в будущем (forward secrecy): ключи эфемерные, живут только в памяти одного соединения;
//   * восстановление после компрометации (post-compromise): периодическая смена ключа новым обменом X-Wing;
//   * защита от повтора: счётчик кадра входит в nonce, принимаются только возрастающие счётчики;
//   * привязка к DTLS: в transcript входят отпечатки DTLS обеих сторон из SDP — ключ нельзя «пересадить»
//     в другое соединение;
//   * меньше метаданных: длина открытого текста выравнивается до 256 байт.
//
// Ограничение (честно): подлинность собеседника подтверждает сервер сигнализации (Supabase Realtime
// с проверкой прав). Проверка долговременных ключей устройств (ML-DSA/Ed25519, «коды безопасности»)
// — следующий этап; без неё активная подмена на сервере сигнализации теоретически возможна.
import { ml_kem768_x25519 } from '@noble/post-quantum/hybrid.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';

const LABEL = 'rv-p2p-v1';
export const PAD_BLOCK = 256;
const HEADER = 9; // 1 байт эпохи ключа + 8 байт счётчика
const enc = new TextEncoder();
const dec = new TextDecoder();

export const kem = ml_kem768_x25519;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function toB64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Отпечаток DTLS из SDP (a=fingerprint) — для привязки ключа к конкретному соединению */
export function dtlsFingerprint(sdp: string | undefined | null): string {
  const m = /a=fingerprint:(\S+) ([0-9A-Fa-f:]+)/.exec(sdp ?? '');
  return m ? `${m[1].toLowerCase()} ${m[2].toUpperCase()}` : '';
}

export interface HandshakeInit {
  pk: Uint8Array;
  nonce: Uint8Array;
}

export interface HandshakeReply {
  ct: Uint8Array;
  nonce: Uint8Array;
}

/** Ключи одной эпохи: отдельный ключ на каждое направление */
export interface EpochKeys {
  epoch: number;
  send: CryptoKey;
  recv: CryptoKey;
  /** Хэш transcript — для отображения и проверки совпадения ключей в тестах */
  id: string;
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function transcript(epoch: number, fpOfferer: string, fpAnswerer: string, init: HandshakeInit, reply: HandshakeReply): Uint8Array {
  return sha256(concat(enc.encode(`${LABEL}|${epoch}|${fpOfferer}|${fpAnswerer}|`), init.pk, init.nonce, reply.ct, reply.nonce));
}

async function deriveKeys(ss: Uint8Array, th: Uint8Array, epoch: number, isOfferer: boolean): Promise<EpochKeys> {
  const okm = hkdf(sha256, ss, th, enc.encode(`${LABEL} keys`), 64);
  const o2a = okm.subarray(0, 32);
  const a2o = okm.subarray(32, 64);
  const keys: EpochKeys = {
    epoch,
    send: await importKey(isOfferer ? o2a : a2o),
    recv: await importKey(isOfferer ? a2o : o2a),
    id: toB64(th).slice(0, 16),
  };
  okm.fill(0);
  return keys;
}

/** Инициатор (сторона, сделавшая SDP offer): эфемерная пара ключей X-Wing */
export function startHandshake(): { init: HandshakeInit; secretKey: Uint8Array } {
  const { publicKey, secretKey } = kem.keygen();
  return { init: { pk: publicKey, nonce: crypto.getRandomValues(new Uint8Array(32)) }, secretKey };
}

/** Ответчик: инкапсуляция общего секрета по ключу инициатора */
export async function answerHandshake(
  init: HandshakeInit,
  epoch: number,
  fpOfferer: string,
  fpAnswerer: string,
): Promise<{ reply: HandshakeReply; keys: EpochKeys }> {
  if (init.pk.length !== kem.lengths.publicKey || init.nonce.length !== 32) throw new Error('bad handshake');
  const { cipherText, sharedSecret } = kem.encapsulate(init.pk);
  const reply = { ct: cipherText, nonce: crypto.getRandomValues(new Uint8Array(32)) };
  const keys = await deriveKeys(sharedSecret, transcript(epoch, fpOfferer, fpAnswerer, init, reply), epoch, false);
  sharedSecret.fill(0);
  return { reply, keys };
}

/** Инициатор: получение общего секрета из ответа */
export async function finishHandshake(
  init: HandshakeInit,
  secretKey: Uint8Array,
  reply: HandshakeReply,
  epoch: number,
  fpOfferer: string,
  fpAnswerer: string,
): Promise<EpochKeys> {
  if (reply.ct.length !== kem.lengths.cipherText || reply.nonce.length !== 32) throw new Error('bad handshake');
  const ss = kem.decapsulate(reply.ct, secretKey);
  secretKey.fill(0);
  const keys = await deriveKeys(ss, transcript(epoch, fpOfferer, fpAnswerer, init, reply), epoch, true);
  ss.fill(0);
  return keys;
}

/** Выравнивание длины: [длина 4 байта][данные][нули до кратного PAD_BLOCK] */
export function pad(data: Uint8Array): Uint8Array {
  const total = Math.ceil((data.length + 4) / PAD_BLOCK) * PAD_BLOCK;
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(data, 4);
  return out;
}

export function unpad(p: Uint8Array): Uint8Array {
  if (p.length < 4) throw new Error('bad padding');
  const n = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0);
  if (n > p.length - 4) throw new Error('bad padding');
  return p.subarray(4, 4 + n);
}

function nonceOf(counter: bigint): Uint8Array {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, counter);
  return iv;
}

export class ReplayError extends Error {
  constructor() {
    super('replay');
    this.name = 'ReplayError';
  }
}

/**
 * Шифрованный поток кадров одной стороны. Эпохи ключей сменяются при повторном обмене X-Wing;
 * кадры прошлой эпохи принимаются ещё короткое время (они могли быть в пути во время смены ключа).
 */
export class SecureSession {
  private cur: EpochKeys;
  private prev: { keys: EpochKeys; until: number } | null = null;
  private sendCounter = 0n;
  private recvCounters = new Map<number, bigint>();
  framesSent = 0;
  framesSinceRekey = 0;
  establishedAt = Date.now();

  constructor(keys: EpochKeys) {
    this.cur = keys;
  }

  get epoch(): number {
    return this.cur.epoch;
  }

  get keyId(): string {
    return this.cur.id;
  }

  rekey(keys: EpochKeys, graceMs = 30_000) {
    if (keys.epoch <= this.cur.epoch) throw new Error('stale epoch');
    this.prev = { keys: this.cur, until: Date.now() + graceMs };
    this.cur = keys;
    this.sendCounter = 0n;
    this.framesSinceRekey = 0;
    this.establishedAt = Date.now();
  }

  async seal(obj: unknown): Promise<Uint8Array> {
    const body = pad(enc.encode(JSON.stringify(obj)));
    const counter = ++this.sendCounter;
    const header = new Uint8Array(HEADER);
    header[0] = this.cur.epoch & 0xff;
    new DataView(header.buffer).setBigUint64(1, counter);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonceOf(counter) as BufferSource, additionalData: header as BufferSource }, this.cur.send, body as BufferSource),
    );
    this.framesSent++;
    this.framesSinceRekey++;
    return concat(header, ct);
  }

  async open(frame: Uint8Array): Promise<unknown> {
    if (frame.length < HEADER + 16) throw new Error('short frame');
    const header = frame.subarray(0, HEADER);
    const epoch = header[0];
    const counter = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(1);
    let keys: EpochKeys | null = null;
    if (epoch === (this.cur.epoch & 0xff)) keys = this.cur;
    else if (this.prev && epoch === (this.prev.keys.epoch & 0xff) && Date.now() < this.prev.until) keys = this.prev.keys;
    if (!keys) throw new Error('unknown epoch');
    const last = this.recvCounters.get(keys.epoch) ?? 0n;
    if (counter <= last) throw new ReplayError();
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonceOf(counter) as BufferSource, additionalData: header.slice() as BufferSource },
        keys.recv,
        frame.subarray(HEADER) as BufferSource,
      ),
    );
    // Счётчик фиксируется только после успешной проверки подлинности
    this.recvCounters.set(keys.epoch, counter);
    return JSON.parse(dec.decode(unpad(plain)));
  }
}
