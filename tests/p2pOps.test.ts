// Правила приёма P2P-операций: дубли, подлинность автора, правки, удаления, реакции, синхронизация истории.
import { beforeEach, describe, expect, it } from 'vitest';
import { applyOp, messageData, parseFrame, syncPlan, type ApplyContext, type OpFrame } from '@/lib/p2p/ops';
import { MemoryStore, toMessage, type StoredMessage } from '@/lib/p2p/store';

const ME = '00000000-0000-4000-8000-00000000000a';
const PEER = '00000000-0000-4000-8000-00000000000b';
const OTHER = '00000000-0000-4000-8000-00000000000c';
const DM = '11111111-1111-4111-8111-111111111111';
const M1 = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-26T10:00:00Z');

let store: MemoryStore;
const ctx = (from: string): ApplyContext => ({ store, me: ME, dm: DM, peer: PEER, from, now: NOW });
const msg = (op: string, data: Record<string, unknown>): OpFrame => ({ k: 'op', op, kind: 'msg', dm: DM, data });
const peerMsg = { id: M1, author_id: PEER, content: 'привет', reply_to_id: null, created_at: '2026-11-26T09:59:00Z' };

beforeEach(() => {
  store = new MemoryStore();
});

describe('P2P-операции', () => {
  it('сообщение собеседника принимается один раз; повтор — duplicate (но будет подтверждён)', async () => {
    const r1 = await applyOp(ctx(PEER), msg('op1', peerMsg));
    expect(r1).toMatchObject({ status: 'applied', fresh: true });
    expect(await applyOp(ctx(PEER), msg('op1', peerMsg))).toEqual({ status: 'duplicate' });
    // Та же версия под другим op (синхронизация) не создаёт дубль
    expect(await applyOp(ctx(PEER), msg('sync:x', peerMsg))).toEqual({ status: 'stale' });
    expect((await store.messagesFor(ME, DM)).length).toBe(1);
  });

  it('собеседник не может прислать сообщение от моего имени или от третьего лица', async () => {
    expect(await applyOp(ctx(PEER), msg('a', { ...peerMsg, author_id: ME }))).toMatchObject({ status: 'rejected' });
    expect(await applyOp(ctx(PEER), msg('b', { ...peerMsg, author_id: OTHER }))).toMatchObject({ status: 'rejected' });
    // Своё другое устройство может передать историю обоих участников
    expect(await applyOp(ctx(ME), msg('c', { ...peerMsg, id: '33333333-3333-4333-8333-333333333333', author_id: ME }))).toMatchObject({ status: 'applied' });
  });

  it('чужая переписка, слишком длинный текст и время из будущего отклоняются', async () => {
    expect(await applyOp(ctx(PEER), { ...msg('a', peerMsg), dm: '44444444-4444-4444-8444-444444444444' })).toMatchObject({ status: 'rejected' });
    expect(await applyOp(ctx(PEER), msg('b', { ...peerMsg, content: 'x'.repeat(4001) }))).toMatchObject({ status: 'rejected' });
    expect(await applyOp(ctx(PEER), msg('c', { ...peerMsg, created_at: '2027-01-01T00:00:00Z' }))).toMatchObject({ status: 'rejected' });
  });

  it('правка и удаление — только автором', async () => {
    await applyOp(ctx(PEER), msg('m', peerMsg));
    const edit = (op: string, from: string) => applyOp(ctx(from), { k: 'op', op, kind: 'edit', dm: DM, data: { id: M1, content: 'исправлено', at: NOW } });
    expect(await edit('e1', ME)).toMatchObject({ status: 'rejected' });
    const ok = await edit('e2', PEER);
    expect(ok).toMatchObject({ status: 'applied' });
    expect((await store.getMessage(M1))!.content).toBe('исправлено');
    const del = await applyOp(ctx(PEER), { k: 'op', op: 'd1', kind: 'del', dm: DM, data: { id: M1, at: NOW + 1 } });
    expect(del).toMatchObject({ status: 'applied' });
    const m = (await store.getMessage(M1))!;
    expect(m.deleted_at).not.toBeNull();
    expect(toMessage(m).content).toBe('');
  });

  it('реакции: собеседник ставит и снимает только свою', async () => {
    await applyOp(ctx(PEER), msg('m', peerMsg));
    const react = (op: string, from: string, user: string, add: boolean) =>
      applyOp(ctx(from), { k: 'op', op, kind: 'react', dm: DM, data: { id: M1, emoji: '👍', add, user, at: NOW } });
    expect(await react('r1', PEER, ME, true)).toMatchObject({ status: 'rejected' });
    await react('r2', PEER, PEER, true);
    await react('r3', ME, ME, true);
    expect((await store.getMessage(M1))!.reactions['👍'].sort()).toEqual([ME, PEER].sort());
    await react('r4', PEER, PEER, false);
    expect((await store.getMessage(M1))!.reactions['👍']).toEqual([ME]);
  });

  it('синхронизация истории: передаются отсутствующие и более новые версии, собеседнику — только свои', () => {
    const base = (id: string, author: string, v: number): StoredMessage => ({
      id, owner: ME, dm_id: DM, author_id: author, content: 't', reply_to_id: null, kind: 'default',
      created_at: '2026-11-26T09:00:00Z', edited_at: null, deleted_at: null, reactions: {}, v,
    });
    const local = [base('a', ME, 1), base('b', ME, 5), base('c', PEER, 1), base('d', ME, 1)];
    const have: [string, number][] = [['b', 3], ['d', 1]];
    expect(syncPlan(local, have, { me: ME, peer: PEER, to: PEER }).map((m) => m.id)).toEqual(['a', 'b']);
    expect(syncPlan(local, have, { me: ME, peer: PEER, to: ME }).map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(messageData(local[0])).toMatchObject({ id: 'a', v: 1 });
  });

  it('разбор кадра отбрасывает мусор', () => {
    expect(parseFrame({ k: 'op', op: 'x', kind: 'drop-table', dm: DM, data: {} })).toBeNull();
    expect(parseFrame({ k: 'op', op: 'x', kind: 'msg', dm: 'nope', data: {} })).toBeNull();
    expect(parseFrame({ k: 'op', op: 'x', kind: 'msg', dm: DM, data: [] })).toBeNull();
    expect(parseFrame({ k: 'op', op: 'x', kind: 'msg', dm: DM, data: {} })).not.toBeNull();
  });
});
