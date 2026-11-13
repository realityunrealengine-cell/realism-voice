// Edge Function voice-sfu: авторизация, права к каналам и ЛС, защита чужих сессий, вызовы API Cloudflare Realtime.
// API Cloudflare и Supabase подменены; проверяется, ЧТО функция отправляет и кому отказывает.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { edge } from './helpers/supabaseEdgeStub';

const env = new Map<string, string>();
let handler: (req: Request) => Promise<Response>;
Object.assign(globalThis, {
  Deno: {
    env: { get: (k: string) => env.get(k) },
    serve: (h: typeof handler) => {
      handler = h;
    },
  },
});

interface SfuCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  auth: string | null;
}
const sfuCalls: SfuCall[] = [];
let sfuReply: (c: SfuCall) => { status?: number; body: unknown } = () => ({ body: {} });
let sessionSeq = 0;

vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
  const u = new URL(url);
  const call: SfuCall = {
    method: init.method ?? 'GET',
    path: u.pathname,
    body: init.body ? JSON.parse(String(init.body)) : null,
    auth: new Headers(init.headers).get('Authorization'),
  };
  sfuCalls.push(call);
  if (u.pathname.endsWith('/sessions/new')) return new Response(JSON.stringify({ sessionId: `sess${++sessionSeq}abcdef` }), { status: 201 });
  const r = sfuReply(call);
  return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
});

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
const MALLORY = 'cccccccc-0000-4000-8000-000000000003';
const CH = '11111111-1111-4111-8111-111111111111';
const PRIVATE = '22222222-2222-4222-8222-222222222222';
const OTHER_CH = '33333333-3333-4333-8333-333333333333';
const DM = '44444444-4444-4444-8444-444444444444';
const SDP = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n';

beforeAll(async () => {
  await import('../supabase/functions/voice-sfu/index.ts');
});

beforeEach(() => {
  env.clear();
  env.set('CF_SFU_APP_ID', 'app123');
  env.set('CF_SFU_APP_TOKEN', 'secret-token');
  env.set('SUPABASE_URL', 'https://x.supabase.co');
  env.set('SUPABASE_ANON_KEY', 'anon');
  edge.users.clear();
  edge.channels.clear();
  edge.dms.clear();
  edge.users.set('jwt-alice', ALICE);
  edge.users.set('jwt-bob', BOB);
  edge.users.set('jwt-mallory', MALLORY);
  for (const u of [ALICE, BOB, MALLORY]) edge.channels.set(`${u}:${CH}`, { can_join: true, can_speak: true, user_limit: null });
  edge.channels.set(`${ALICE}:${PRIVATE}`, { can_join: true, can_speak: true, user_limit: null });
  edge.channels.set(`${MALLORY}:${PRIVATE}`, { can_join: false, can_speak: false, user_limit: null });
  edge.channels.set(`${MALLORY}:${OTHER_CH}`, { can_join: true, can_speak: true, user_limit: null });
  edge.dms.add(`${ALICE}:${DM}`);
  edge.dms.add(`${BOB}:${DM}`);
  sfuCalls.length = 0;
  sfuReply = () => ({ body: {} });
});

async function call(jwt: string | null, body: unknown) {
  const res = await handler(
    new Request('https://x.supabase.co/functions/v1/voice-sfu', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('Edge Function voice-sfu', () => {
  it('без секретов Cloudflare — понятная ошибка «не настроено»', async () => {
    env.delete('CF_SFU_APP_TOKEN');
    const r = await call('jwt-alice', { action: 'join', channel_id: CH });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('voice_not_configured');
  });

  it('без входа в аккаунт или с поддельным JWT — 401', async () => {
    expect((await call(null, { action: 'join', channel_id: CH })).status).toBe(401);
    expect((await call('forged', { action: 'join', channel_id: CH })).status).toBe(401);
    expect(sfuCalls).toHaveLength(0);
  });

  it('вход в канал: две сессии SFU, STUN Cloudflare, секрет только в заголовке запроса к Cloudflare', async () => {
    const r = await call('jwt-alice', { action: 'join', channel_id: CH });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ room: `ch_${CH}`, can_speak: true, user_limit: null });
    expect(r.body.pub.id).toMatch(/^sess/);
    expect(r.body.sub.id).toMatch(/^sess/);
    expect(r.body.ice_servers).toEqual([{ urls: 'stun:stun.cloudflare.com:3478' }]);
    expect(sfuCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/apps/app123/sessions/new',
      'POST /v1/apps/app123/sessions/new',
    ]);
    expect(sfuCalls.every((c) => c.auth === 'Bearer secret-token')).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain('secret-token');
  });

  it('приватный канал без доступа — 403, сессии SFU не создаются', async () => {
    const r = await call('jwt-mallory', { action: 'join', channel_id: PRIVATE });
    expect(r.status).toBe(403);
    expect(sfuCalls).toHaveLength(0);
  });

  it('режим слушателя: сессии публикации нет, публикация запрещена', async () => {
    edge.channels.set(`${BOB}:${CH}`, { can_join: true, can_speak: false, user_limit: null });
    const r = await call('jwt-bob', { action: 'join', channel_id: CH });
    expect(r.body.can_speak).toBe(false);
    expect(r.body.pub).toBeNull();
    expect(r.body.sub).not.toBeNull();
  });

  it('личный звонок: только участники переписки', async () => {
    expect((await call('jwt-alice', { action: 'join', dm_id: DM })).status).toBe(200);
    expect((await call('jwt-mallory', { action: 'join', dm_id: DM })).status).toBe(403);
  });

  it('лимит участников канала (задан администратором) передаётся клиенту', async () => {
    edge.channels.set(`${ALICE}:${CH}`, { can_join: true, can_speak: true, user_limit: 5 });
    expect((await call('jwt-alice', { action: 'join', channel_id: CH })).body.user_limit).toBe(5);
  });

  it('публикация: имя трека содержит комнату, SDP-предложение уходит в tracks/new, ответ возвращается клиенту', async () => {
    const j = await call('jwt-alice', { action: 'join', channel_id: CH });
    sfuReply = (c) => ({
      body: {
        sessionDescription: { type: 'answer', sdp: 'v=0\r\nanswer' },
        tracks: (c.body!.tracks as { mid: string; trackName: string }[]).map((t) => ({ mid: t.mid, trackName: t.trackName })),
      },
    });
    const r = await call('jwt-alice', { action: 'publish', session: j.body.pub, sdp: SDP, tracks: [{ mid: '0', source: 'mic' }] });
    expect(r.status).toBe(200);
    expect(r.body.sdp).toBe('v=0\r\nanswer');
    expect(r.body.tracks[0].name).toMatch(new RegExp(`^ch_${CH}\\.mic\\.`));
    const sent = sfuCalls.at(-1)!;
    expect(sent.path).toBe(`/v1/apps/app123/sessions/${j.body.pub.id}/tracks/new`);
    expect(sent.body).toMatchObject({ sessionDescription: { type: 'offer', sdp: SDP }, tracks: [{ location: 'local', mid: '0' }] });
  });

  it('чужая или поддельная сессия — 403 (нельзя управлять чужими треками)', async () => {
    const j = await call('jwt-alice', { action: 'join', channel_id: CH });
    const before = sfuCalls.length;
    expect((await call('jwt-mallory', { action: 'publish', session: j.body.pub, sdp: SDP, tracks: [{ mid: '0', source: 'mic' }] })).status).toBe(403);
    const forged = { id: 'sessXYZabcdef', token: j.body.pub.token };
    expect((await call('jwt-alice', { action: 'publish', session: forged, sdp: SDP, tracks: [{ mid: '0', source: 'mic' }] })).status).toBe(403);
    // ключ приёма нельзя использовать для публикации
    expect((await call('jwt-alice', { action: 'publish', session: j.body.sub, sdp: SDP, tracks: [{ mid: '0', source: 'mic' }] })).status).toBe(403);
    expect((await call('jwt-mallory', { action: 'close', pub: { ...j.body.pub, mids: ['0'] } })).status).toBe(403);
    expect(sfuCalls.length).toBe(before);
  });

  it('права перепроверяются: после лишения доступа подписка и публикация запрещены', async () => {
    const j = await call('jwt-alice', { action: 'join', channel_id: PRIVATE });
    edge.channels.set(`${ALICE}:${PRIVATE}`, { can_join: false, can_speak: false, user_limit: null });
    expect((await call('jwt-alice', { action: 'publish', session: j.body.pub, sdp: SDP, tracks: [{ mid: '0', source: 'mic' }] })).status).toBe(403);
    const name = `ch_${PRIVATE}.mic.abcdefghijkl`;
    expect((await call('jwt-alice', { action: 'subscribe', session: j.body.sub, tracks: [{ session: 'sess1abcdef', name }] })).status).toBe(403);
  });

  it('подписка только на треки своей комнаты: трек приватного канала из другой комнаты недоступен', async () => {
    const j = await call('jwt-mallory', { action: 'join', channel_id: OTHER_CH });
    const before = sfuCalls.length;
    const r = await call('jwt-mallory', {
      action: 'subscribe',
      session: j.body.sub,
      tracks: [{ session: 'sess1abcdef', name: `ch_${PRIVATE}.mic.abcdefghijkl` }],
    });
    expect(r.status).toBe(403);
    expect(sfuCalls.length).toBe(before);
  });

  it('подписка: SFU присылает предложение, ответ клиента уходит в renegotiate', async () => {
    const j = await call('jwt-bob', { action: 'join', channel_id: CH });
    const name = `ch_${CH}.mic.abcdefghijkl`;
    sfuReply = () => ({
      body: { requiresImmediateRenegotiation: true, sessionDescription: { type: 'offer', sdp: 'v=0\r\noffer' }, tracks: [{ trackName: name, mid: '3', sessionId: 'sess1abcdef' }] },
    });
    const r = await call('jwt-bob', { action: 'subscribe', session: j.body.sub, tracks: [{ session: 'sess1abcdef', name }] });
    expect(r.body).toEqual({ sdp: 'v=0\r\noffer', renegotiate: true, tracks: [{ name, mid: '3' }] });
    expect(sfuCalls.at(-1)!.body).toEqual({ tracks: [{ location: 'remote', sessionId: 'sess1abcdef', trackName: name }] });
    sfuReply = () => ({ body: {} });
    const a = await call('jwt-bob', { action: 'answer', session: j.body.sub, sdp: SDP });
    expect(a.status).toBe(200);
    expect(sfuCalls.at(-1)).toMatchObject({ method: 'PUT', path: `/v1/apps/app123/sessions/${j.body.sub.id}/renegotiate`, body: { sessionDescription: { type: 'answer', sdp: SDP } } });
  });

  it('трек ещё не готов у SFU — ошибка по треку, а не всего запроса', async () => {
    const j = await call('jwt-bob', { action: 'join', channel_id: CH });
    const name = `ch_${CH}.mic.abcdefghijkl`;
    sfuReply = () => ({ body: { tracks: [{ trackName: name, errorCode: 'track_not_found', errorDescription: 'x' }] } });
    const r = await call('jwt-bob', { action: 'subscribe', session: j.body.sub, tracks: [{ session: 'sess1abcdef', name }] });
    expect(r.status).toBe(200);
    expect(r.body.tracks[0]).toMatchObject({ name, error: 'track_not_found' });
    expect(r.body.renegotiate).toBe(false);
  });

  it('снятие трека: согласованное закрытие с SDP; выход: принудительное закрытие', async () => {
    const j = await call('jwt-alice', { action: 'join', channel_id: CH });
    sfuReply = () => ({ body: { sessionDescription: { type: 'answer', sdp: 'v=0\r\nclosed' }, tracks: [{ mid: '1' }] } });
    const r = await call('jwt-alice', { action: 'unpublish', session: j.body.pub, sdp: SDP, mids: ['1'] });
    expect(r.body.sdp).toBe('v=0\r\nclosed');
    expect(sfuCalls.at(-1)).toMatchObject({ method: 'PUT', body: { force: false, tracks: [{ mid: '1' }], sessionDescription: { type: 'offer' } } });
    sfuReply = () => ({ body: { tracks: [{ mid: '0' }] } });
    await call('jwt-alice', { action: 'close', pub: { ...j.body.pub, mids: ['0'] }, sub: { ...j.body.sub, mids: ['2', '3'] } });
    const closes = sfuCalls.filter((c) => c.path.endsWith('/tracks/close') && c.body!.force === true);
    expect(closes).toHaveLength(2);
  });

  it('ошибка ключей Cloudflare — понятное сообщение о секретах', async () => {
    const j = await call('jwt-alice', { action: 'join', channel_id: CH });
    sfuReply = () => ({ status: 401, body: { errorCode: 'unauthorized' } });
    const r = await call('jwt-alice', { action: 'publish', session: j.body.pub, sdp: SDP, tracks: [{ mid: '0', source: 'mic' }] });
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/CF_SFU_APP_TOKEN/);
  });

  it('некорректные данные отклоняются до обращения к Cloudflare', async () => {
    const j = await call('jwt-alice', { action: 'join', channel_id: CH });
    const before = sfuCalls.length;
    expect((await call('jwt-alice', { action: 'publish', session: j.body.pub, sdp: 'garbage', tracks: [{ mid: '0', source: 'mic' }] })).status).toBe(400);
    expect((await call('jwt-alice', { action: 'publish', session: j.body.pub, sdp: SDP, tracks: [{ mid: '0', source: 'keylogger' }] })).status).toBe(400);
    expect((await call('jwt-alice', { action: 'join', channel_id: 'not-a-uuid' })).status).toBe(400);
    expect((await call('jwt-alice', { action: 'drop_database' })).status).toBe(400);
    expect(sfuCalls.length).toBe(before);
  });

  it('TURN Cloudflare подключается только если заданы его секреты (порт 53 отфильтрован)', async () => {
    env.set('CF_TURN_KEY_ID', 'turnkey');
    env.set('CF_TURN_KEY_API_TOKEN', 'turntoken');
    sfuReply = (c) =>
      c.path.includes('/turn/keys/')
        ? {
            body: {
              iceServers: [
                { urls: ['stun:stun.cloudflare.com:3478'] },
                { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' },
              ],
            },
          }
        : { body: {} };
    const r = await call('jwt-alice', { action: 'join', channel_id: CH });
    expect(r.body.ice_servers[1].urls).toEqual(['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp']);
    expect(sfuCalls.find((c) => c.path.includes('/turn/'))!.auth).toBe('Bearer turntoken');
  });
});
