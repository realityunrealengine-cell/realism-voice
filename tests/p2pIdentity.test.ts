// Ключи устройств (Ed25519 + ML-DSA-65), коды безопасности, список доверия и шифрование локальной истории.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  decodePublic, encodePublic, fingerprint, identityFromSeeds, newIdentity, publicOf, safetyCode, signHybrid, verifyHybrid,
} from '@/lib/p2p/identity';
import { TrustStore, type KnownKey } from '@/lib/p2p/trust';
import { IdbStore, type StoredMessage } from '@/lib/p2p/store';

const msg = new TextEncoder().encode('handshake transcript');

describe('ключ устройства', () => {
  it('гибридная подпись проверяется, только если верны обе части', () => {
    const { id } = newIdentity();
    const sig = signHybrid(id, msg);
    expect(verifyHybrid(publicOf(id), msg, sig)).toBe(true);
    expect(verifyHybrid(publicOf(id), new TextEncoder().encode('other'), sig)).toBe(false);
    const badEd = { ...sig, ed: sig.ed.slice() };
    badEd.ed[0] ^= 1;
    expect(verifyHybrid(publicOf(id), msg, badEd)).toBe(false);
    const badPq = { ...sig, pq: sig.pq.slice() };
    badPq.pq[10] ^= 1;
    expect(verifyHybrid(publicOf(id), msg, badPq)).toBe(false);
    // Подпись другим ключом не подходит
    expect(verifyHybrid(publicOf(newIdentity().id), msg, sig)).toBe(false);
  });

  it('ключ восстанавливается из сохранённых зёрен и кодируется для передачи', () => {
    const { id, seeds } = newIdentity();
    const again = identityFromSeeds(Uint8Array.from(Buffer.from(seeds.ed, 'base64')), Uint8Array.from(Buffer.from(seeds.pq, 'base64')));
    expect(fingerprint(publicOf(again))).toBe(fingerprint(publicOf(id)));
    const decoded = decodePublic(encodePublic(publicOf(id)))!;
    expect(fingerprint(decoded)).toBe(fingerprint(publicOf(id)));
    expect(decodePublic({ ed: 'AAAA', pq: 'AAAA' })).toBeNull();
  });

  it('код безопасности: 60 цифр, одинаков у обеих сторон, меняется при смене ключа', () => {
    const a = { userId: 'aaaa', pub: publicOf(newIdentity().id) };
    const b = { userId: 'bbbb', pub: publicOf(newIdentity().id) };
    const code = safetyCode(a, b);
    expect(code.replace(/ /g, '')).toMatch(/^\d{60}$/);
    expect(safetyCode(b, a)).toBe(code);
    expect(safetyCode(a, { userId: 'bbbb', pub: publicOf(newIdentity().id) })).not.toBe(code);
  });
});

describe('список доверия (TOFU)', () => {
  const mem = () => {
    let s: Record<string, KnownKey[]> = {};
    return { load: () => s, save: (v: Record<string, KnownKey[]>) => (s = JSON.parse(JSON.stringify(v))) };
  };

  it('первый ключ запоминается, смена — предупреждение и снятие отметки «проверено», отзыв запрещает', () => {
    const t = new TrustStore(mem());
    const k1 = publicOf(newIdentity().id);
    const k2 = publicOf(newIdentity().id);
    expect(t.observe('u', k1)).toBe('first');
    expect(t.observe('u', k1)).toBe('known');
    t.setVerified('u', fingerprint(k1), true);
    expect(t.observe('u', k2)).toBe('new-key');
    expect(t.keys('u').every((k) => !k.verified)).toBe(true);
    t.setRevoked('u', fingerprint(k2), true);
    expect(t.allowed('u', k2)).toBe(false);
    expect(t.observe('u', k2)).toBe('revoked');
    expect(t.allowed('u', k1)).toBe(true);
  });
});

describe('шифрование локальной P2P-истории', () => {
  it('на диске нет открытого текста, чтение расшифровывает, записи 1.3.0 перешифровываются', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const store = new IdbStore(async () => key);
    const m: StoredMessage = {
      id: '11111111-1111-4111-8111-111111111111', owner: 'me', dm_id: 'dm1', author_id: 'me', content: 'секретный текст',
      reply_to_id: null, kind: 'default', created_at: '2026-11-26T10:00:00Z', edited_at: null, deleted_at: null, reactions: {}, v: 1,
    };
    store.putMessage(m);
    store.putOp({ op: 'op1', owner: 'me', dm: 'dm1', to: 'peer', kind: 'msg', data: { content: 'секретный текст' }, created: 1, attempts: 0 });
    await store.flush();

    const raw = await new Promise<unknown[]>((resolve) => {
      const r = indexedDB.open('rv-p2p', 1);
      r.onsuccess = () => {
        const tx = r.result.transaction(['messages', 'outbox'], 'readonly');
        const a = tx.objectStore('messages').getAll();
        const b = tx.objectStore('outbox').getAll();
        tx.oncomplete = () => resolve([...a.result, ...b.result]);
      };
    });
    expect(JSON.stringify(raw)).not.toContain('секретный');
    expect(raw.every((x) => typeof (x as { enc?: unknown }).enc === 'string')).toBe(true);

    const fresh = new IdbStore(async () => key);
    expect((await fresh.messagesFor('me', 'dm1'))[0].content).toBe('секретный текст');
    expect((await fresh.outbox('me'))[0].data).toEqual({ content: 'секретный текст' });

    // Чужим ключом не читается (запись пропускается, а не выдаётся мусором)
    const other = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    expect(await new IdbStore(async () => other).messagesFor('me', 'dm1')).toEqual([]);

    // Запись версии 1.3.0 (открытым текстом) читается и перешифровывается
    await new Promise<void>((resolve) => {
      const r = indexedDB.open('rv-p2p', 1);
      r.onsuccess = () => {
        const tx = r.result.transaction('messages', 'readwrite');
        tx.objectStore('messages').put({ ...m, id: '22222222-2222-4222-8222-222222222222', content: 'старое сообщение' });
        tx.oncomplete = () => resolve();
      };
    });
    const s3 = new IdbStore(async () => key);
    expect((await s3.messagesFor('me', 'dm1')).map((x) => x.content).sort()).toEqual(['секретный текст', 'старое сообщение']);
    await s3.flush();
    const after = await new Promise<unknown>((resolve) => {
      const r = indexedDB.open('rv-p2p', 1);
      r.onsuccess = () => {
        const q = r.result.transaction('messages').objectStore('messages').get('22222222-2222-4222-8222-222222222222');
        q.onsuccess = () => resolve(q.result);
      };
    });
    expect(JSON.stringify(after)).not.toContain('старое');
  });
});
