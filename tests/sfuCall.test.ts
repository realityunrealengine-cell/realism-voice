// Голосовая комната через Cloudflare Realtime SFU — несколько участников на поддельных SFU, WebRTC и Realtime.
// Проверяется логика (подписки, mute, выход, демонстрация экрана, восстановление, очистка), а не реальная сеть.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomFullError, SfuCall, type CallEvents } from '@/lib/sfu/call';
import type { Quality, RoomMember, Source } from '@/lib/sfu/protocol';
import { FakePC, FakeRealtimeServer, FakeRtClient, FakeSfu, FakeTrack } from './helpers/fakeSfu';

const U = {
  A: '00000000-0000-4000-8000-00000000000a',
  B: '00000000-0000-4000-8000-00000000000b',
  C: '00000000-0000-4000-8000-00000000000c',
};
const CH = '11111111-1111-4111-8111-111111111111';

interface Rec {
  call: SfuCall;
  rt: FakeRtClient;
  tracks: Map<string, FakeTrack | null>;
  rosters: RoomMember[][];
  statuses: string[];
  lost: number;
  superseded: number;
  speaking: Set<string>;
  quality: Quality[];
}

let server: FakeRealtimeServer;
let sfu: FakeSfu;
let online = true;
let onlineListeners: (() => void)[] = [];

function make(user: string, session = `dev-${user.slice(-1)}`): Rec {
  const rt = new FakeRtClient(server);
  const rec = {
    rt,
    tracks: new Map(),
    rosters: [],
    statuses: [],
    lost: 0,
    superseded: 0,
    speaking: new Set<string>(),
    quality: [],
  } as unknown as Rec;
  const ev: CallEvents = {
    roster: (o) => rec.rosters.push(o),
    track: (u, s, t) => rec.tracks.set(`${u}:${s}`, t as unknown as FakeTrack | null),
    status: (s, a) => rec.statuses.push(`${s}:${a}`),
    lost: () => rec.lost++,
    superseded: () => rec.superseded++,
    speaking: (ids) => (rec.speaking = ids),
    quality: (q) => rec.quality.push(q),
  };
  rec.call = new SfuCall({ kind: 'channel', channelId: CH }, user, session, ev, {
    api: sfu.api(user),
    rt,
    pcFactory: (cfg) => new FakePC(cfg) as unknown as RTCPeerConnection,
    online: () => online,
    onOnline: (fn) => {
      onlineListeners.push(fn);
      return () => (onlineListeners = onlineListeners.filter((f) => f !== fn));
    },
  });
  return rec;
}

const mic = () => ({ mic: { track: new FakeTrack('audio') as unknown as MediaStreamTrack } });

async function flush(ms = 0) {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(ms ? ms / 20 : 0);
}

async function joinAll(...recs: Rec[]) {
  for (const r of recs) {
    const p = r.call.start(async () => mic());
    await flush(1600);
    await p;
  }
  await flush(100);
}

const pcsOf = (r: Rec) => ({
  pub: (r.call as unknown as { pub: { pc: FakePC } | null }).pub?.pc ?? null,
  sub: (r.call as unknown as { sub: { pc: FakePC | null } | null }).sub?.pc ?? null,
});

const heard = (r: Rec, user: string, source: Source = 'mic') => !!r.tracks.get(`${user}:${source}`);

describe('комната Cloudflare Realtime SFU', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    server = new FakeRealtimeServer();
    sfu = new FakeSfu();
    online = true;
    onlineListeners = [];
    FakePC.all = [];
    FakePC.connectable = true;
  });
  afterEach(() => vi.useRealTimers());

  it('три участника: каждый слышит двух других, список участников одинаков у всех', async () => {
    const a = make(U.A);
    const b = make(U.B);
    const c = make(U.C);
    await joinAll(a, b, c);
    for (const [me, others] of [
      [a, [U.B, U.C]],
      [b, [U.A, U.C]],
      [c, [U.A, U.B]],
    ] as const) {
      expect(me.call.others.map((o) => o.userId).sort()).toEqual([...others].sort());
      for (const o of others) expect(heard(me, o)).toBe(true);
    }
    expect(sfu.activePulls(U.A)).toHaveLength(2);
    // Каждый трек принимается ровно один раз (нет дублирования звука)
    expect(new Set(sfu.activePulls(U.A)).size).toBe(2);
    // В SDP публикации включён Opus DTX
    expect(pcsOf(a).pub!.localDescription!.sdp).toMatch(/usedtx=1/);
    await Promise.all([a, b, c].map((r) => r.call.close()));
  });

  it('mute и «оглушение» видны остальным, а трек микрофона не закрывается (SFU не удалит его по таймауту)', async () => {
    const a = make(U.A);
    const b = make(U.B);
    await joinAll(a, b);
    a.call.setFlags({ muted: true, deafened: true });
    await flush(10);
    const seen = b.call.others.find((o) => o.userId === U.A)!;
    expect(seen).toMatchObject({ muted: true, deafened: true });
    expect(sfu.activePublished().filter((t) => t.user === U.A && t.source === 'mic')).toHaveLength(1);
    await Promise.all([a.call.close(), b.call.close()]);
  });

  it('выход участника: соединения закрыты, треки закрыты в SFU, остальные отписались', async () => {
    const a = make(U.A);
    const b = make(U.B);
    const c = make(U.C);
    await joinAll(a, b, c);
    const cPcs = pcsOf(c);
    await c.call.close();
    await flush(100);
    expect(cPcs.pub!.connectionState).toBe('closed');
    expect(cPcs.sub!.connectionState).toBe('closed');
    expect(sfu.activePublished().some((t) => t.user === U.C)).toBe(false);
    expect(heard(a, U.C)).toBe(false);
    expect(heard(b, U.C)).toBe(false);
    expect(a.call.others.map((o) => o.userId)).toEqual([U.B]);
    expect(sfu.activePulls(U.A)).toHaveLength(1);
    expect(sfu.calls).toContain(`${U.A}:unsubscribe`);
    await Promise.all([a.call.close(), b.call.close()]);
  });

  it('демонстрация экрана со звуком: смотрят несколько участников, остановка убирает видео у всех', async () => {
    const a = make(U.A);
    const b = make(U.B);
    const c = make(U.C);
    await joinAll(a, b, c);
    await a.call.setSources({
      screen: { track: new FakeTrack('video') as unknown as MediaStreamTrack, encoding: { maxBitrate: 2_500_000, maxFramerate: 15 } },
      screenAudio: { track: new FakeTrack('audio') as unknown as MediaStreamTrack },
    });
    await flush(100);
    for (const viewer of [b, c]) {
      expect(heard(viewer, U.A, 'screen')).toBe(true);
      expect(heard(viewer, U.A, 'screenAudio')).toBe(true);
    }
    await a.call.setSources({ screen: null, screenAudio: null });
    await flush(100);
    for (const viewer of [b, c]) {
      expect(heard(viewer, U.A, 'screen')).toBe(false);
      expect(heard(viewer, U.A, 'screenAudio')).toBe(false);
      expect(heard(viewer, U.A, 'mic')).toBe(true);
    }
    expect(sfu.activePublished().filter((t) => t.user === U.A).map((t) => t.source)).toEqual(['mic']);
    await Promise.all([a, b, c].map((r) => r.call.close()));
  });

  it('камера: публикация и снятие без переподключения микрофона', async () => {
    const a = make(U.A);
    const b = make(U.B);
    await joinAll(a, b);
    const micName = sfu.activePublished().find((t) => t.user === U.A && t.source === 'mic')!.name;
    await a.call.setSources({ camera: { track: new FakeTrack('video') as unknown as MediaStreamTrack } });
    await flush(50);
    expect(heard(b, U.A, 'camera')).toBe(true);
    await a.call.setSources({ camera: null });
    await flush(50);
    expect(heard(b, U.A, 'camera')).toBe(false);
    expect(sfu.activePublished().find((t) => t.user === U.A && t.source === 'mic')!.name).toBe(micName);
    await Promise.all([a.call.close(), b.call.close()]);
  });

  it('сбой медиасоединения: новая сессия SFU, треки опубликованы заново, участник не выходил из комнаты', async () => {
    const a = make(U.A);
    const b = make(U.B);
    await joinAll(a, b);
    const oldPub = pcsOf(a).pub!;
    const oldName = sfu.activePublished().find((t) => t.user === U.A)!.name;
    const rostersBefore = b.rosters.length;
    oldPub.setConnection('failed');
    expect(a.statuses.at(-1)).toBe('reconnecting:0');
    await flush(1500);
    await flush(200);
    expect(a.statuses.at(-1)).toBe('connected:0');
    expect(oldPub.connectionState).toBe('closed');
    const newName = sfu.activePublished().find((t) => t.user === U.A)!.name;
    expect(newName).not.toBe(oldName);
    expect(heard(b, U.A)).toBe(true);
    expect(sfu.activePulls(U.B)).toEqual([newName]);
    // У собеседника A ни разу не пропадал из списка
    expect(b.rosters.slice(rostersBefore).every((r) => r.some((m) => m.userId === U.A))).toBe(true);
    await Promise.all([a.call.close(), b.call.close()]);
  });

  it('кратковременный disconnected (меньше 5 с) не вызывает переподключение', async () => {
    const a = make(U.A);
    await joinAll(a);
    const pc = pcsOf(a).pub!;
    pc.setConnection('disconnected');
    await flush(3000);
    pc.setConnection('connected');
    await flush(5000);
    expect(a.statuses).toEqual([]);
    expect(sfu.calls.filter((x) => x.includes(':join:')).length).toBe(1);
    await a.call.close();
  });

  it('нет интернета: попытки не тратятся, восстановление после появления сети', async () => {
    const a = make(U.A);
    const b = make(U.B);
    await joinAll(a, b);
    online = false;
    pcsOf(a).pub!.setConnection('failed');
    await flush(20_000);
    expect(sfu.calls.filter((x) => x.startsWith(`${U.A}:join:`))).toHaveLength(1);
    expect(a.lost).toBe(0);
    online = true;
    onlineListeners.forEach((f) => f());
    await flush(1500);
    await flush(200);
    expect(a.statuses.at(-1)).toBe('connected:0');
    expect(heard(b, U.A)).toBe(true);
    await Promise.all([a.call.close(), b.call.close()]);
  });

  it('окончательная потеря: через минуту без успеха — «Соединение потеряно»', async () => {
    const a = make(U.A);
    await joinAll(a);
    sfu.failJoins = 1000;
    pcsOf(a).pub!.setConnection('failed');
    await flush(61_000);
    expect(a.lost).toBe(1);
    await a.call.close();
  });

  it('вход тем же пользователем с другого устройства: старое устройство узнаёт об этом', async () => {
    const a1 = make(U.A, 'device-one');
    const b = make(U.B);
    await joinAll(a1, b);
    await vi.advanceTimersByTimeAsync(5);
    const a2 = make(U.A, 'device-two');
    await joinAll(a2);
    expect(a1.superseded).toBe(1);
    expect(a2.superseded).toBe(0);
    // у собеседника пользователь A один
    expect(b.call.others.filter((o) => o.userId === U.A)).toHaveLength(1);
    await Promise.all([a1.call.close(), a2.call.close(), b.call.close()]);
  });

  it('режим слушателя: не публикует, но слышит остальных', async () => {
    sfu.listeners.add(U.B);
    const a = make(U.A);
    const b = make(U.B);
    const provided: boolean[] = [];
    await joinAll(a);
    const p = b.call.start(async (canSpeak) => {
      provided.push(canSpeak);
      return {};
    });
    await flush(1600);
    await p;
    await flush(50);
    expect(provided).toEqual([false]);
    expect(b.call.canSpeak).toBe(false);
    expect(heard(b, U.A)).toBe(true);
    expect(a.call.others.find((o) => o.userId === U.B)).toMatchObject({ muted: true, tracks: [] });
    await Promise.all([a.call.close(), b.call.close()]);
  });

  it('лимит участников, заданный администратором канала', async () => {
    sfu.userLimit = 2;
    const a = make(U.A);
    const b = make(U.B);
    await joinAll(a, b);
    const c = make(U.C);
    const p = c.call.start(async () => mic());
    const caught = p.catch((e) => e);
    await flush(1600);
    expect(await caught).toBeInstanceOf(RoomFullError);
    await c.call.close();
    await flush(10);
    expect(a.call.others.map((o) => o.userId)).toEqual([U.B]);
    await Promise.all([a.call.close(), b.call.close()]);
  });

  it('индикатор «говорит» по уровню принятого звука', async () => {
    const a = make(U.A);
    const b = make(U.B);
    await joinAll(a, b);
    const recv = pcsOf(b).sub!.transceivers.find((t) => t.kind === 'audio')!;
    recv.receiver.level = 0.2;
    await flush(400);
    expect(b.speaking.has(U.A)).toBe(true);
    recv.receiver.level = 0;
    await flush(1000);
    expect(b.speaking.has(U.A)).toBe(false);
    await Promise.all([a.call.close(), b.call.close()]);
  });

  it('медиасоединение не устанавливается (UDP заблокирован): понятная ошибка, без утечек', async () => {
    FakePC.connectable = false;
    const a = make(U.A);
    const p = a.call.start(async () => mic()).catch((e) => e);
    await flush(20_000);
    expect(String(await p)).toMatch(/UDP/);
    await a.call.close();
    expect(FakePC.all.every((pc) => pc.connectionState === 'closed')).toBe(true);
  });

  it('после выхода всех участников не остаётся открытых RTCPeerConnection и присутствия', async () => {
    const a = make(U.A);
    const b = make(U.B);
    const c = make(U.C);
    await joinAll(a, b, c);
    await a.call.setSources({ screen: { track: new FakeTrack('video') as unknown as MediaStreamTrack } });
    await flush(50);
    await Promise.all([a, b, c].map((r) => r.call.close()));
    await flush(100);
    expect(FakePC.all.length).toBeGreaterThan(0);
    expect(FakePC.all.every((pc) => pc.connectionState === 'closed')).toBe(true);
    expect(sfu.activePublished()).toEqual([]);
    expect(server.state(`typing:${CH}`)).toEqual({});
  });
});
