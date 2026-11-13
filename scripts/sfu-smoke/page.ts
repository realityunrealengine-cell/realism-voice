// Страница реальной проверки (см. main.cjs): два участника, настоящие RTCPeerConnection и Cloudflare Realtime SFU.
// Состав комнаты передаётся через поддельный сервер presence в этой же странице (Supabase Realtime здесь не нужен).
import { SfuCall, type CallEvents } from '@/lib/sfu/call';
import { AudioOut } from '@/lib/sfu/audioOut';
import type { JoinTarget, SessionGrant, VoiceApi } from '@/lib/sfu/api';
import { FakeRealtimeServer, FakeRtClient } from '../../tests/helpers/fakeSfu';

declare global {
  interface Window {
    smoke: { invoke(user: string, body: unknown): Promise<{ status: number; body: any }>; log(m: string): void; done(ok: boolean): void };
  }
}

const log = (m: string) => window.smoke.log(m);
const CH = crypto.randomUUID();
const A = crypto.randomUUID();
const B = crypto.randomUUID();
let ok = true;

function check(name: string, pass: boolean, extra = '') {
  if (!pass) ok = false;
  log(`${pass ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`);
}

function api(user: string): VoiceApi {
  const call = async (body: Record<string, unknown>) => {
    const r = await window.smoke.invoke(user, body);
    if (r.status !== 200) throw new Error(`${body.action}: HTTP ${r.status} ${r.body?.error ?? ''} ${r.body?.message ?? ''}`);
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

const pcs: RTCPeerConnection[] = [];
const server = new FakeRealtimeServer();

interface Peer {
  call: SfuCall;
  tracks: Map<string, MediaStreamTrack | null>;
  statuses: string[];
}

function participant(user: string): Peer {
  const p = { tracks: new Map(), statuses: [] } as unknown as Peer;
  const ev: CallEvents = {
    roster: () => undefined,
    track: (u, s, t) => p.tracks.set(`${u}:${s}`, t),
    status: (s, a) => p.statuses.push(`${s}:${a}`),
    lost: () => p.statuses.push('lost'),
    superseded: () => p.statuses.push('superseded'),
    speaking: () => undefined,
    quality: () => undefined,
  };
  p.call = new SfuCall({ kind: 'channel', channelId: CH }, user, crypto.randomUUID(), ev, {
    api: api(user),
    rt: new FakeRtClient(server),
    pcFactory: (cfg) => {
      const pc = new RTCPeerConnection(cfg);
      pcs.push(pc);
      return pc;
    },
    log: (m) => log(`   · ${user.slice(0, 4)}: ${m}`),
  });
  return p;
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

const subPc = (p: Peer) => (p.call as unknown as { sub: { pc: RTCPeerConnection | null } | null }).sub?.pc ?? null;

async function inbound(pc: RTCPeerConnection | null, kind: 'audio' | 'video') {
  let bytes = 0;
  let frames = 0;
  let level = 0;
  if (!pc) return { bytes, frames, level };
  const stats = await pc.getStats();
  stats.forEach((s: any) => {
    if (s.type === 'inbound-rtp' && s.kind === kind) {
      bytes += s.bytesReceived ?? 0;
      frames += s.framesDecoded ?? 0;
      level = Math.max(level, s.audioLevel ?? 0);
    }
  });
  return { bytes, frames, level };
}

function tone(freq: number): MediaStreamTrack {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  osc.frequency.value = freq;
  const gain = ctx.createGain();
  gain.gain.value = 0.3;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();
  void ctx.resume();
  return dest.stream.getAudioTracks()[0];
}

function screenLike(): MediaStreamTrack {
  const c = document.getElementById('c') as HTMLCanvasElement;
  const g = c.getContext('2d')!;
  let n = 0;
  setInterval(() => {
    g.fillStyle = `hsl(${n++ % 360} 70% 50%)`;
    g.fillRect(0, 0, 640, 360);
    g.fillStyle = '#fff';
    g.font = '48px sans-serif';
    g.fillText(`Realism Voice ${n}`, 40, 180);
  }, 66);
  return c.captureStream(15).getVideoTracks()[0];
}

async function run() {
  log(`Комната ch_${CH.slice(0, 8)}…, участники A и B (Chromium ${navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1]})`);
  const a = participant(A);
  const b = participant(B);
  const micA = tone(440);
  const micB = tone(660);

  let t0 = performance.now();
  await a.call.start(async () => ({ mic: { track: micA } }));
  check('A вошёл и опубликовал микрофон (Edge Function → Cloudflare SFU, ICE/DTLS установлены)', true, `${Math.round(performance.now() - t0)} мс`);
  t0 = performance.now();
  await b.call.start(async () => ({ mic: { track: micB } }));
  check('B вошёл и опубликовал микрофон', true, `${Math.round(performance.now() - t0)} мс`);

  const heard = await until(() => !!a.tracks.get(`${B}:mic`) && !!b.tracks.get(`${A}:mic`), 15_000);
  check('A и B подписались на микрофоны друг друга', heard, `${Math.round(performance.now() - t0)} мс от входа B`);

  const s1 = await inbound(subPc(b), 'audio');
  await sleep(2500);
  const s2 = await inbound(subPc(b), 'audio');
  check('звук A реально приходит к B через SFU', s2.bytes - s1.bytes > 4000, `+${s2.bytes - s1.bytes} байт за 2,5 с, уровень ${s2.level.toFixed(3)}`);
  const sa = await inbound(subPc(a), 'audio');
  check('звук B реально приходит к A', sa.bytes > 4000, `${sa.bytes} байт`);

  // Воспроизведение у B той же цепочкой, что в приложении (Web Audio, громкость участника)
  const outCtx = new AudioContext();
  await outCtx.resume();
  const out = new AudioOut(outCtx);
  out.setVolumes(() => 1);
  out.add('a-mic', A, 'mic', b.tracks.get(`${A}:mic`)!);
  const entry = (out as unknown as { entries: Map<string, { gain: GainNode }> }).entries.get('a-mic')!;
  const an = outCtx.createAnalyser();
  an.fftSize = 2048;
  entry.gain.connect(an);
  await sleep(1500);
  const buf = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(buf);
  const rms = Math.sqrt(buf.reduce((x, v) => x + v * v, 0) / buf.length);
  check('принятый звук A воспроизводится у B (Web Audio, не тишина)', rms > 0.01, `RMS ${rms.toFixed(3)}`);
  out.setVolumes(() => 0);
  await sleep(300);
  an.getFloatTimeDomainData(buf);
  const rms0 = Math.sqrt(buf.reduce((x, v) => x + v * v, 0) / buf.length);
  check('громкость участника 0 % (или «оглушение») глушит звук', rms0 < 0.002, `RMS ${rms0.toFixed(4)}`);
  out.clear();
  void outCtx.close();

  // демонстрация экрана
  await a.call.setSources({ screen: { track: screenLike(), encoding: { maxBitrate: 2_500_000, maxFramerate: 15 } } });
  const gotScreen = await until(() => !!b.tracks.get(`${A}:screen`), 15_000);
  check('B получил демонстрацию экрана A', gotScreen);
  await sleep(3000);
  const v = await inbound(subPc(b), 'video');
  check('кадры демонстрации декодируются у B', v.frames > 10, `${v.frames} кадров`);

  // mute: трек остаётся, пакеты идут (SFU не удалит трек), флаг виден собеседнику
  micA.enabled = false;
  a.call.setFlags({ muted: true, deafened: false });
  await sleep(300);
  check('B видит, что A выключил микрофон', !!b.call.others.find((o) => o.userId === A)?.muted);
  const m1 = await inbound(subPc(b), 'audio');
  await sleep(2000);
  const m2 = await inbound(subPc(b), 'audio');
  check('при выключенном микрофоне соединение живо (служебные пакеты идут)', m2.bytes > m1.bytes, `+${m2.bytes - m1.bytes} байт`);
  micA.enabled = true;
  a.call.setFlags({ muted: false, deafened: false });

  // восстановление: новая сессия публикации, переопубликование, переподписка у B
  const before = b.tracks.get(`${A}:mic`);
  t0 = performance.now();
  a.call.recover('pub');
  const recovered = await until(() => a.statuses.at(-1) === 'connected:0', 20_000);
  const resub = await until(() => !!b.tracks.get(`${A}:mic`) && b.tracks.get(`${A}:mic`) !== before, 15_000);
  check('восстановление после сбоя: новая сессия SFU и переподписка собеседника', recovered && resub, `${Math.round(performance.now() - t0)} мс`);
  const r1 = await inbound(subPc(b), 'audio');
  await sleep(2000);
  const r2 = await inbound(subPc(b), 'audio');
  check('после восстановления звук A снова идёт к B', r2.bytes > r1.bytes + 3000, `+${r2.bytes - r1.bytes} байт`);
  check('после восстановления демонстрация у B снова есть', await until(() => !!b.tracks.get(`${A}:screen`), 15_000));

  // остановка демонстрации
  await a.call.setSources({ screen: null });
  check('остановка демонстрации убирает видео у B', await until(() => !b.tracks.get(`${A}:screen`), 10_000));

  // выход
  await a.call.close();
  check('выход A: B больше не видит и не принимает A', await until(() => b.call.others.length === 0 && !b.tracks.get(`${A}:mic`), 10_000));
  await b.call.close();
  [micA, micB].forEach((t) => t.stop());
  check('все RTCPeerConnection закрыты (нет утечек)', pcs.every((pc) => pc.connectionState === 'closed'), `${pcs.length} соединений`);
  window.smoke.done(ok);
}

run().catch((e) => {
  log(`✘ ОШИБКА: ${(e as Error)?.message ?? e}`);
  window.smoke.done(false);
});
