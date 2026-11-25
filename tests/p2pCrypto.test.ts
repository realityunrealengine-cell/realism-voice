// Гибридный обмен ключами X-Wing (X25519 + ML-KEM-768) и шифрованные кадры P2P-канала.
import { describe, expect, it } from 'vitest';
import {
  answerHandshake, dtlsFingerprint, finishHandshake, kem, pad, PAD_BLOCK, ReplayError, SecureSession, startHandshake, unpad,
} from '@/lib/p2p/crypto';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

const FP_A = 'sha-256 AA:BB';
const FP_B = 'sha-256 CC:DD';

async function pair(epoch = 1) {
  const { init, secretKey } = startHandshake();
  const { reply, keys: rk } = await answerHandshake(init, epoch, FP_A, FP_B);
  const ik = await finishHandshake(init, secretKey, reply, epoch, FP_A, FP_B);
  return { ik, rk, init, reply };
}

describe('P2P: постквантовый гибридный канал', () => {
  it('используется X-Wing: открытый ключ ML-KEM-768 + X25519 (1184 + 32 байта)', () => {
    expect(kem.lengths.publicKey).toBe(ml_kem768.lengths.publicKey + 32);
    expect(kem.lengths.cipherText).toBe(ml_kem768.lengths.cipherText + 32);
  });

  it('обе стороны получают одинаковые ключи и расшифровывают кадры друг друга', async () => {
    const { ik, rk } = await pair();
    expect(ik.id).toBe(rk.id);
    const a = new SecureSession(ik);
    const b = new SecureSession(rk);
    expect(await b.open(await a.seal({ hello: 'мир' }))).toEqual({ hello: 'мир' });
    expect(await a.open(await b.seal({ n: 42 }))).toEqual({ n: 42 });
  });

  it('другие отпечатки DTLS дают другой ключ (ключ привязан к соединению)', async () => {
    const { init, secretKey } = startHandshake();
    const { reply, keys: rk } = await answerHandshake(init, 1, FP_A, FP_B);
    const ik = await finishHandshake(init, secretKey, reply, 1, FP_A, 'sha-256 EE:FF');
    expect(ik.id).not.toBe(rk.id);
    await expect(new SecureSession(rk).open(await new SecureSession(ik).seal({ x: 1 }))).rejects.toThrow();
  });

  it('повтор кадра отклоняется, изменённый кадр не расшифровывается', async () => {
    const { ik, rk } = await pair();
    const a = new SecureSession(ik);
    const b = new SecureSession(rk);
    const f1 = await a.seal({ i: 1 });
    const f2 = await a.seal({ i: 2 });
    expect(await b.open(f2)).toEqual({ i: 2 });
    await expect(b.open(f1)).rejects.toBeInstanceOf(ReplayError);
    await expect(b.open(f2)).rejects.toBeInstanceOf(ReplayError);
    const f3 = await a.seal({ i: 3 });
    const bad = f3.slice();
    bad[bad.length - 1] ^= 1;
    await expect(b.open(bad)).rejects.toThrow();
    // Отвергнутый поддельный кадр не сдвигает счётчик: настоящий принимается
    expect(await b.open(f3)).toEqual({ i: 3 });
  });

  it('длина открытого текста скрыта выравниванием до 256 байт', async () => {
    const { ik } = await pair();
    const a = new SecureSession(ik);
    const short = await a.seal({ t: 'a' });
    const longer = await a.seal({ t: 'a'.repeat(200) });
    expect(short.length).toBe(longer.length);
    expect(unpad(pad(new Uint8Array([1, 2, 3])))).toEqual(new Uint8Array([1, 2, 3]));
    expect(pad(new Uint8Array(PAD_BLOCK - 4)).length).toBe(PAD_BLOCK);
  });

  it('смена ключа: новая эпоха, старые кадры в пути ещё принимаются', async () => {
    const one = await pair(1);
    const a = new SecureSession(one.ik);
    const b = new SecureSession(one.rk);
    const inFlight = await a.seal({ old: true });
    const two = await pair(2);
    a.rekey(two.ik);
    b.rekey(two.rk);
    expect(a.epoch).toBe(2);
    expect(await b.open(await a.seal({ fresh: true }))).toEqual({ fresh: true });
    expect(await b.open(inFlight)).toEqual({ old: true });
    expect(two.ik.id).not.toBe(one.ik.id);
  });

  it('неверная длина ключа или шифротекста отклоняется', async () => {
    const { init } = startHandshake();
    await expect(answerHandshake({ pk: init.pk.slice(1), nonce: init.nonce }, 1, FP_A, FP_B)).rejects.toThrow();
    const { init: i2, secretKey } = startHandshake();
    await expect(finishHandshake(i2, secretKey, { ct: new Uint8Array(10), nonce: new Uint8Array(32) }, 1, FP_A, FP_B)).rejects.toThrow();
  });

  it('отпечаток DTLS извлекается из SDP', () => {
    expect(dtlsFingerprint('v=0\r\na=fingerprint:sha-256 ab:cd:EF\r\n')).toBe('sha-256 AB:CD:EF');
    expect(dtlsFingerprint('v=0')).toBe('');
  });
});
