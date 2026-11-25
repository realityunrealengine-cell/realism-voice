// Страница реальной P2P-проверки (см. main.cjs).
import { SfuCall, type CallEvents, type CallTransport } from '@/lib/sfu/call';
import { AudioOut } from '@/lib/sfu/audioOut';
import type { JoinTarget, SessionGrant, VoiceApi } from '@/lib/sfu/api';
import { P2pHub } from '@/lib/p2p/hub';
import { MemoryStore } from '@/lib/p2p/store';
import type { Message } from '@/lib/types';
import { FakeChannel, FakeRealtimeServer, FakeRtClient } from '../../tests/helpers/fakeSfu';

declare global {
  interface Window {
    smoke: { invoke(user: string, body: unknown): Promise<{ status: number; body: any }>; haveSfu(): Promise<boolean>; log(m: string): void; done(ok: boolean): void };
  }
}

const log = (m: string) => window.smoke.log(m);
let ok = true;
function check(name: string, pass: boolean, extra = '') {
  if (!pass) ok = false;
  log(`${pass ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}
const uuid = () => crypto.randomUUID();
const STUN: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/** Сервер Realtime в памяти, который умеет «терять» сигнализацию P2P (имитация её блокировки) */
class LossyServer extends FakeRealtimeServer {
  drop: (event: string) => boolean = () => false;
  send(from: FakeChannel, event: string, payload: unknown) {
    if (this.drop(event)) return;
    super.send(from, event, payload);
  }
}
const server = new LossyServer();

// ---------- API SFU: настоящий (через voice-sfu) или заглушка без SFU ----------
const sfuCalls = { publish: 0, subscribe: 0 };
function api(user: string, haveSfu: boolean): VoiceApi {
  const call = async (body: Record<string, unknown>) => {
    if (body.action === 'publish') sfuCalls.publish++;
    if (body.action === 'subscribe') sfuCalls.subscribe++;
    if (!haveSfu) {
      if (body.action === 'join') return { room: 'x', can_speak: true, user_limit: null, ice_servers: STUN, pub: { id: `p${uuid().slice(0, 8)}`, token: 't' }, sub: { id: `s${uuid().slice(0, 8)}`, token: 't' } };
      if (body.action === 'close') return { ok: true };
      throw new Error(`SFU недоступен в этом прогоне (${body.action})`);
    }
    const r = await window.smoke.invoke(user, body);
    if (r.status !== 200) throw new Error(`${body.action}: HTTP ${r.status} ${r.body?.error ?? ''}`);
    return r.body;
  };
  const g = (s: SessionGrant) => ({ id: s.id, token: s.token });
  return {
    join: (t: JoinTarget, scope = 'all') => call({ action: 'join', scope, ...(t.kind === 'channel' ? { channel_id: t.channelId } : { dm_id: t.dmId }) }),
    publish: (s, sdp, tracks) => call({ action: 'publish', session: g(s), sdp, tracks }),
    unpublish: (s, sdp, mids) => call({ action: 'unpublish', session: g(s), sdp, mids }),
    subscribe: (s, tracks) => call({ action: 'subscribe', session: g(s), tracks }),
    answer: async (s, sdp) => {
      await call({ action: 'answer', session: g(s), sdp });
    },
    unsubscribe: (s, sdp, mids) => call({ action: 'unsubscribe', session: g(s), sdp, mids }),
    close: async (pub, sub) => {
      const body: Record<string, unknown> = { action: 'close' };
      if (pub?.mids.length) body.pub = { ...g(pub.session), mids: pub.mids };
      if (sub?.mids.length) body.sub = { ...g(sub.session), mids: sub.mids };
      if (body.pub || body.sub) await call(body);
    },
  };
}

// ---------- звук ----------
const ctx = new AudioContext();
function tone(freq: number): MediaStreamTrack {
  const osc = ctx.createOscillator();
  osc.frequency.value = freq;
  const gain = ctx.createGain();
  gain.gain.value = 0.3;
  const dst = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dst);
  osc.start();
  return dst.stream.getAudioTracks()[0];
}
function cameraTrack(): MediaStreamTrack {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 180;
  const g = c.getContext('2d')!;
  let i = 0;
  setInterval(() => {
    g.fillStyle = `hsl(${i++ % 360},80%,50%)`;
    g.fillRect(0, 0, 320, 180);
  }, 40);
  return c.captureStream(25).getVideoTracks()[0];
}

interface Peer {
  user: string;
  call: SfuCall;
  out: AudioOut;
  tracks: Map<string, MediaStreamTrack | null>;
  transport: CallTransport | null;
  traffic: Record<string, number>;
}

function participant(user: string, dm: string, direct: boolean, haveSfu: boolean): Peer {
  const out = new AudioOut(ctx);
  out.setVolumes(() => 1);
  const p = { user, out, tracks: new Map(), transport: null, traffic: { p2p: 0, relay: 0, sfu: 0 } } as unknown as Peer;
  const ev: CallEvents = {
    roster: () => undefined,
    track: (u, s, t) => {
      p.tracks.set(`${u}:${s}`, t);
      if (s === 'mic') {
        if (t) out.add(`${u}:mic`, u, s, t);
        else out.remove(`${u}:mic`);
      }
    },
    status: () => undefined,
    lost: () => undefined,
    superseded: () => undefined,
    speaking: () => undefined,
    quality: () => undefined,
    transport: (t) => (p.transport = t),
  };
  p.call = new SfuCall({ kind: 'dm', dmId: dm }, user, uuid(), ev, {
    api: api(user, haveSfu),
    rt: new FakeRtClient(server),
    level: (u) => out.level(`${u}:mic`),
    direct: { allowed: direct, relayOnly: false },
    traffic: (k, s, r) => (p.traffic[k] += s + r),
    log: (m) => {
      if (/direct|fallback|failed/i.test(m)) log(`   · ${user.slice(0, 4)}: ${m}`);
    },
  });
  return p;
}

const directPc = (p: Peer) => (p.call as unknown as { direct: { pc: RTCPeerConnection } | null }).direct?.pc ?? null;
const hears = (p: Peer, from: Peer) => (p.out.level(`${from.user}:mic`) ?? 0) > 0.005;

async function stunCheck() {
  log('\n1. STUN Cloudflare: определение внешнего адреса (нужно для прямого соединения через NAT)');
  const pc = new RTCPeerConnection({ iceServers: STUN });
  pc.createDataChannel('x');
  const types = new Set<string>();
  pc.onicecandidate = (e) => e.candidate && types.add(e.candidate.type ?? '?');
  await pc.setLocalDescription();
  await until(() => pc.iceGatheringState === 'complete', 8000);
  pc.close();
  check('получен srflx-кандидат (публичный адрес через STUN)', types.has('srflx'), [...types].join(', '));
}

async function directCall(haveSfu: boolean) {
  log('\n2. Личный звонок напрямую (P2P), без Cloudflare SFU');
  const dm = uuid();
  const A = participant(uuid(), dm, true, haveSfu);
  const B = participant(uuid(), dm, true, haveSfu);
  sfuCalls.publish = sfuCalls.subscribe = 0;
  await A.call.start(async () => ({ mic: { track: tone(440) } }));
  await B.call.start(async () => ({ mic: { track: tone(660) } }));
  check('обе стороны перешли на P2P', await until(() => A.transport === 'p2p' && B.transport === 'p2p', 15000), `${A.transport} / ${B.transport}`);
  check('A слышит B и B слышит A (напрямую)', await until(() => hears(A, B) && hears(B, A), 8000));
  check('ни одной публикации или подписки в SFU', sfuCalls.publish === 0 && sfuCalls.subscribe === 0, `publish ${sfuCalls.publish}, subscribe ${sfuCalls.subscribe}`);
  await sleep(3500);
  check('трафик учтён как P2P (из getStats)', A.traffic.p2p > 0 && A.traffic.sfu === 0, `p2p ${A.traffic.p2p} Б, sfu ${A.traffic.sfu} Б`);

  const cam = cameraTrack();
  await A.call.setSources({ camera: { track: cam, encoding: { maxBitrate: 500_000 } } });
  check('камера A приходит B напрямую', await until(() => !!B.tracks.get(`${A.user}:camera`), 8000));
  await A.call.setSources({ camera: null });
  check('камера снята — у B трек убран', await until(() => !B.tracks.get(`${A.user}:camera`), 8000));
  return { A, B };
}

async function midCallFailure(A: Peer, B: Peer) {
  log('\n3. Обрыв прямого соединения во время звонка → переход на Cloudflare SFU без выхода из звонка');
  directPc(A)?.close();
  check('обе стороны перешли на SFU', await until(() => A.transport === 'sfu' && B.transport === 'sfu', 30000), `${A.transport} / ${B.transport}`);
  check('после перехода снова слышат друг друга (через SFU)', await until(() => hears(A, B) && hears(B, A), 20000));
  check('публикация в SFU выполнена', sfuCalls.publish > 0, `publish ${sfuCalls.publish}`);
}

async function blockedSignal() {
  log('\n4. Прямое соединение невозможно (сигнализация P2P заблокирована) → SFU через 10 с');
  const dm = uuid();
  server.drop = (e) => e === 'p2p-call';
  const C = participant(uuid(), dm, true, true);
  const D = participant(uuid(), dm, true, true);
  await C.call.start(async () => ({ mic: { track: tone(500) } }));
  await D.call.start(async () => ({ mic: { track: tone(700) } }));
  check('обе стороны перешли на SFU', await until(() => C.transport === 'sfu' && D.transport === 'sfu', 25000), `${C.transport} / ${D.transport}`);
  check('слышат друг друга через SFU', await until(() => hears(C, D) && hears(D, C), 20000));
  server.drop = () => false;
  await Promise.all([C.call.close(), D.call.close()]);
}

async function oldClient() {
  log('\n5. Собеседник со старой версией (без P2P) → сразу через SFU');
  const dm = uuid();
  const E = participant(uuid(), dm, false, true);
  const F = participant(uuid(), dm, true, true);
  await E.call.start(async () => ({ mic: { track: tone(520) } }));
  await F.call.start(async () => ({ mic: { track: tone(720) } }));
  check('звонок идёт через SFU', await until(() => F.transport === 'sfu', 15000), String(F.transport));
  check('слышат друг друга', await until(() => hears(E, F) && hears(F, E), 20000));
  await Promise.all([E.call.close(), F.call.close()]);
}

// ---------- сообщения ----------
function hub(me: string, store: MemoryStore, rec: Message[], bytes: { n: number }) {
  return new P2pHub({
    me,
    store,
    rt: () => new FakeRtClient(server),
    iceServers: STUN,
    log: (m) => {
      if (/rejected|failed|limit/.test(m) || (window as any).P2P_DEBUG) log(`   · ${me.slice(0, 4)}: ${m}`);
    },
    onMessage: (m) => rec.push(m),
    onBytes: (s, r) => (bytes.n += s + r),
  });
}

async function messages() {
  log('\n6. P2P-сообщения: шифрование X25519+ML-KEM-768, подтверждения, очередь, дубли, история');
  const A = uuid();
  const B = uuid();
  const dm = uuid();
  const sA = new MemoryStore();
  const sB = new MemoryStore();
  const rA: Message[] = [];
  const rB: Message[] = [];
  const bytes = { n: 0 };
  const hA = hub(A, sA, rA, bytes);
  let hB = hub(B, sB, rB, bytes);
  check('в режиме Auto без канала — сразу на сервер', (await hA.sendMessage(dm, B, { id: uuid(), content: 'x', reply_to_id: null, created_at: new Date().toISOString() }, 3000)) === 'fallback');
  hA.setRooms([{ dm, peer: B }]);
  hB.setRooms([{ dm, peer: A }]);
  check('защищённый канал установлен', await until(() => hA.reachable(dm) && hB.reachable(dm), 20000));

  const id1 = uuid();
  const r1 = await hA.sendMessage(dm, B, { id: id1, content: 'привет напрямую', reply_to_id: null, created_at: new Date().toISOString() }, 3000);
  check('сообщение доставлено P2P с подтверждением', r1 === 'p2p');
  check('получатель видит текст', rB.some((m) => m.id === id1 && m.content === 'привет напрямую' && m._via === 'p2p'));
  check('у отправителя отмечено «доставлено»', await until(() => sA.msgs.get(id1)?.delivered === true, 3000));

  await hA.edit(dm, B, id1, 'исправлено');
  check('правка дошла', await until(() => sB.msgs.get(id1)?.content === 'исправлено', 5000));
  await hB.react(dm, A, id1, '🔥', true);
  check('реакция дошла', await until(() => (sA.msgs.get(id1)?.reactions['🔥'] ?? []).includes(B), 5000));

  log('   получатель выходит из сети (закрыл приложение)');
  await hB.stop();
  const id2 = uuid();
  const r2 = await hA.sendMessage(dm, B, { id: id2, content: 'пока тебя не было', reply_to_id: null, created_at: new Date().toISOString() }, null);
  check('«Только P2P»: сообщение ждёт в очереди', r2 === 'queued' && (await sA.outbox(A)).length === 1);
  await sleep(1500);
  log('   получатель снова запускает приложение');
  const before = rB.length;
  hB = hub(B, sB, rB, bytes);
  hB.setRooms([{ dm, peer: A }]);
  check('после переподключения очередь доставлена', await until(() => !!sB.msgs.get(id2), 30000));
  check('очередь отправителя пуста, отмечено «доставлено»', await until(() => sA.ops.size === 0 && sA.msgs.get(id2)?.delivered === true, 5000));
  await sleep(1500);
  check('без дублей у получателя', rB.slice(before).filter((m) => m.id === id2).length === 1 && [...sB.msgs.values()].filter((m) => m.id === id2).length === 1);

  log('   второе устройство отправителя: синхронизация истории');
  const sA2 = new MemoryStore();
  const hA2 = hub(A, sA2, [], bytes);
  hA2.setRooms([{ dm, peer: B }]);
  check('история перенесена на второе устройство', await until(() => sA2.msgs.size === sA.msgs.size && sA2.msgs.get(id1)?.content === 'исправлено', 30000), `${sA2.msgs.size}/${sA.msgs.size}`);

  log('   смена ключа (повторный обмен X-Wing) во время работы');
  for (const h of [hA, hB]) for (const room of (h as any).rooms.values()) for (const e of room.links.values()) e.link.rekeyNow();
  await sleep(1000);
  const id3 = uuid();
  check('после смены ключа сообщения доставляются', (await hA.sendMessage(dm, B, { id: id3, content: 'новый ключ', reply_to_id: null, created_at: new Date().toISOString() }, 3000)) === 'p2p');
  check('байты P2P-сообщений измерены', bytes.n > 0, `${bytes.n} Б`);
  await Promise.all([hA.stop(), hB.stop(), hA2.stop()]);
}

(async () => {
  if (location.hash === '#messages') {
    (window as any).P2P_DEBUG = true;
    for (let i = 0; i < 4; i++) {
      log(`--- прогон ${i + 1}`);
      await messages().catch((e) => check('исключение', false, String(e)));
    }
    window.smoke.done(ok);
    return;
  }
  const haveSfu = await window.smoke.haveSfu();
  log(haveSfu ? 'Cloudflare SFU: ключи найдены (.env.sfu-test) — переход на сервер проверяется по-настоящему' : 'Cloudflare SFU: ключей нет — части 3–5 пропущены');
  try {
    await stunCheck();
    const { A, B } = await directCall(haveSfu);
    if (haveSfu) {
      await midCallFailure(A, B);
      await Promise.all([A.call.close(), B.call.close()]);
      await blockedSignal();
      await oldClient();
    } else {
      await Promise.all([A.call.close(), B.call.close()]);
    }
    await messages();
  } catch (e) {
    check('исключение', false, (e as Error)?.stack ?? String(e));
  }
  window.smoke.done(ok);
})();
