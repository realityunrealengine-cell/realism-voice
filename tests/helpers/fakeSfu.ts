// Поддельные Supabase Realtime, RTCPeerConnection и Cloudflare Realtime SFU для автотестов.
// Это НЕ проверка реальной связи через интернет: здесь проверяется логика сигнализации, подписок,
// переподключения и очистки. Реальный звук проверяется вручную на тестовой сборке.
import type { RtChannel, RtClient, SubscribeStatus } from '@/lib/presenceChannel';
import type { JoinResult, JoinTarget, SessionGrant, VoiceApi } from '@/lib/sfu/api';
import type { Source } from '@/lib/sfu/protocol';

type Meta = Record<string, unknown>;

// ---------------- Realtime presence ----------------
export class FakeRealtimeServer {
  channels = new Set<FakeChannel>();
  state(topic: string): Record<string, Meta[]> {
    const out: Record<string, Meta[]> = {};
    for (const ch of this.channels) {
      if (ch.topic !== topic || !ch.tracked) continue;
      (out[ch.key] ??= []).push(ch.tracked);
    }
    return out;
  }
  broadcast(topic: string) {
    for (const ch of [...this.channels]) if (ch.topic === topic) ch.receive(this.state(topic));
  }
}

export class FakeChannel implements RtChannel {
  status: 'closed' | 'joining' | 'joined' = 'closed';
  tracked: Meta | null = null;
  key: string;
  private syncCb: (() => void) | null = null;
  private last: Record<string, Meta[]> = {};
  constructor(
    private readonly client: FakeRtClient,
    readonly topic: string,
    opts: { config: { presence: { key: string } } },
  ) {
    this.key = opts.config.presence.key;
  }
  on(_t: 'presence', _f: { event: 'sync' }, cb: () => void) {
    this.syncCb = cb;
    return this;
  }
  subscribe(cb: (s: SubscribeStatus, e?: Error) => void) {
    if (this.status !== 'closed') return this;
    this.status = 'joining';
    queueMicrotask(() => {
      if (!this.client.allowed(this.topic)) {
        this.status = 'closed';
        cb('CHANNEL_ERROR', new Error('Unauthorized'));
        return;
      }
      this.status = 'joined';
      this.client.server.channels.add(this);
      cb('SUBSCRIBED');
      this.client.server.broadcast(this.topic);
    });
    return this;
  }
  async track(p: Meta) {
    if (this.status !== 'joined') return 'error';
    this.tracked = p;
    this.client.server.broadcast(this.topic);
    return 'ok';
  }
  async untrack() {
    if (this.status !== 'joined') return 'error';
    this.tracked = null;
    this.client.server.broadcast(this.topic);
    return 'ok';
  }
  presenceState() {
    return this.last;
  }
  receive(state: Record<string, Meta[]>) {
    if (this.status !== 'joined') return;
    this.last = state;
    this.syncCb?.();
  }
  drop() {
    this.status = 'closed';
    this.tracked = null;
    this.client.server.channels.delete(this);
    this.client.server.broadcast(this.topic);
  }
}

export class FakeRtClient implements RtClient {
  channelsByTopic = new Map<string, FakeChannel>();
  constructor(
    readonly server: FakeRealtimeServer,
    readonly allowed: (topic: string) => boolean = () => true,
  ) {}
  channel(topic: string, opts: { config: { private: boolean; presence: { key: string } } }) {
    const ex = this.channelsByTopic.get(topic);
    if (ex) return ex;
    const ch = new FakeChannel(this, topic, opts);
    this.channelsByTopic.set(topic, ch);
    return ch;
  }
  async removeChannel(ch: RtChannel) {
    const c = ch as FakeChannel;
    c.drop();
    this.channelsByTopic.delete(c.topic);
    return 'ok';
  }
  /** Обрыв соединения клиента с Realtime: сервер снимает его присутствие */
  disconnectAll() {
    for (const ch of this.channelsByTopic.values()) ch.drop();
    this.channelsByTopic.clear();
  }
}

// ---------------- WebRTC ----------------
let trackSeq = 0;
export class FakeTrack {
  id = `t${++trackSeq}`;
  readyState: 'live' | 'ended' = 'live';
  enabled = true;
  contentHint = '';
  constructor(readonly kind: 'audio' | 'video') {}
  stop() {
    this.readyState = 'ended';
  }
  getSettings() {
    return {};
  }
  addEventListener() {}
}

interface FakeSdp {
  type: 'offer' | 'answer';
  mids: { mid: string; kind: 'audio' | 'video'; stopped?: boolean }[];
  sessionTag?: string;
}

export function fakeSdp(d: FakeSdp): string {
  return `v=0\r\na=x-fake:${JSON.stringify(d)}\r\n`;
}
export function parseFakeSdp(sdp: string): FakeSdp {
  const m = /a=x-fake:(.*)\r\n/.exec(sdp);
  if (!m) throw new Error('not a fake sdp');
  return JSON.parse(m[1]) as FakeSdp;
}

export class FakeTransceiver {
  mid: string | null = null;
  stopped = false;
  currentDirection: string | null = null;
  sender: { track: FakeTrack | null; replaceTrack: (t: FakeTrack | null) => Promise<void> };
  receiver: { track: FakeTrack; level: number; getSynchronizationSources: () => { audioLevel: number }[] };
  constructor(
    readonly kind: 'audio' | 'video',
    track: FakeTrack | null,
    readonly direction: string,
  ) {
    const self = this;
    this.sender = {
      track,
      async replaceTrack(t) {
        self.sender.track = t;
      },
    };
    this.receiver = {
      track: new FakeTrack(kind),
      level: 0,
      getSynchronizationSources() {
        return [{ audioLevel: self.receiver.level }];
      },
    };
  }
  stop() {
    this.stopped = true;
    this.receiver.track.stop();
  }
}

export class FakePC extends EventTarget {
  static all: FakePC[] = [];
  transceivers: FakeTransceiver[] = [];
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  private nextMid = 0;
  /** Медиасоединение установится только если true (иначе — «UDP заблокирован») */
  static connectable = true;
  constructor(readonly config: RTCConfiguration) {
    super();
    FakePC.all.push(this);
  }
  addTransceiver(track: FakeTrack, init: { direction: string }) {
    const t = new FakeTransceiver(track.kind, track, init.direction);
    this.transceivers.push(t);
    return t;
  }
  async createOffer() {
    for (const t of this.transceivers) if (t.mid === null) t.mid = String(this.nextMid++);
    return {
      type: 'offer' as const,
      sdp: fakeSdp({ type: 'offer', mids: this.transceivers.map((t) => ({ mid: t.mid!, kind: t.kind, stopped: t.stopped })) }).replace(
        'v=0\r\n',
        'v=0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n',
      ),
    };
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: fakeSdp({ type: 'answer', mids: this.transceivers.map((t) => ({ mid: t.mid!, kind: t.kind, stopped: t.stopped })) }) };
  }
  private setSignaling(s: RTCSignalingState) {
    this.signalingState = s;
    this.dispatchEvent(new Event('signalingstatechange'));
  }
  setConnection(s: RTCPeerConnectionState) {
    if (this.connectionState === s || this.connectionState === 'closed') return;
    this.connectionState = s;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
  async setLocalDescription(d: { type: string; sdp?: string }) {
    if (this.connectionState === 'closed') throw new Error('closed');
    this.localDescription = { type: d.type, sdp: d.sdp ?? '' };
    this.setSignaling(d.type === 'offer' ? 'have-local-offer' : 'stable');
    if (d.type === 'answer') this.maybeConnect();
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    if (this.connectionState === 'closed') throw new Error('closed');
    this.remoteDescription = d;
    const parsed = parseFakeSdp(d.sdp);
    if (d.type === 'answer') {
      this.setSignaling('stable');
      this.maybeConnect();
      return;
    }
    // Предложение SFU: новые m-строки → новые приёмные трансиверы и события track
    for (const m of parsed.mids) {
      if (m.stopped || this.transceivers.some((t) => t.mid === m.mid)) continue;
      const t = new FakeTransceiver(m.kind, null, 'recvonly');
      t.mid = m.mid;
      this.transceivers.push(t);
      const ev = Object.assign(new Event('track'), { transceiver: t, track: t.receiver.track, receiver: t.receiver, streams: [] });
      this.dispatchEvent(ev);
    }
    this.setSignaling('have-remote-offer');
  }
  private maybeConnect() {
    if (this.connectionState === 'new' || this.connectionState === 'connecting') {
      queueMicrotask(() => {
        if (FakePC.connectable) this.setConnection('connected');
      });
    }
  }
  async getStats() {
    return new Map<string, Record<string, unknown>>();
  }
  close() {
    this.connectionState = 'closed';
    this.signalingState = 'closed';
    for (const t of this.transceivers) t.stop();
  }
}

// ---------------- Cloudflare Realtime SFU + Edge Function ----------------
interface FakeSession {
  id: string;
  user: string;
  room: string;
  kind: 'pub' | 'sub';
  published: Map<string, { mid: string; name: string; source: Source; closed: boolean }>;
  pulled: Map<string, { name: string; closed: boolean }>;
  nextMid: number;
}

export class FakeSfu {
  sessions = new Map<string, FakeSession>();
  calls: string[] = [];
  private seq = 0;
  /** Пользователи, у которых нет права говорить (режим слушателя) */
  listeners = new Set<string>();
  /** Комнаты, куда пользователю нельзя (приватный канал) */
  denied = new Set<string>();
  userLimit: number | null = null;
  failJoins = 0;

  newSession(user: string, room: string, kind: 'pub' | 'sub'): SessionGrant {
    const id = `sess${++this.seq}xxxxxx`;
    this.sessions.set(id, { id, user, room, kind, published: new Map(), pulled: new Map(), nextMid: 0 });
    return { id, token: `tok:${id}:${user}` };
  }

  private own(g: SessionGrant, user: string, kind: 'pub' | 'sub'): FakeSession {
    const s = this.sessions.get(g.id);
    if (!s || g.token !== `tok:${g.id}:${user}` || s.kind !== kind) throw Object.assign(new Error('bad session'), { status: 403 });
    return s;
  }

  activePublished(): { user: string; name: string; source: Source }[] {
    const out: { user: string; name: string; source: Source }[] = [];
    for (const s of this.sessions.values()) for (const t of s.published.values()) if (!t.closed) out.push({ user: s.user, name: t.name, source: t.source });
    return out;
  }

  activePulls(user: string): string[] {
    const out: string[] = [];
    for (const s of this.sessions.values()) if (s.user === user) for (const p of s.pulled.values()) if (!p.closed) out.push(p.name);
    return out.sort();
  }

  api(user: string): VoiceApi {
    const roomOf = (t: JoinTarget) => (t.kind === 'channel' ? `ch_${t.channelId}` : `dm_${t.dmId}`);
    return {
      join: async (target, scope = 'all'): Promise<JoinResult> => {
        this.calls.push(`${user}:join:${scope}`);
        if (this.failJoins > 0) {
          this.failJoins--;
          throw Object.assign(new Error('network'), { status: 0 });
        }
        const room = roomOf(target);
        if (this.denied.has(`${user}:${room}`)) throw new Error('Нет доступа к этому голосовому каналу');
        const canSpeak = !this.listeners.has(user);
        return {
          room,
          can_speak: canSpeak,
          user_limit: this.userLimit,
          ice_servers: scope === 'all' ? [{ urls: 'stun:stun.cloudflare.com:3478' }] : null,
          pub: scope !== 'sub' && canSpeak ? this.newSession(user, room, 'pub') : null,
          sub: scope !== 'pub' ? this.newSession(user, room, 'sub') : null,
        };
      },
      publish: async (g, sdp, tracks) => {
        this.calls.push(`${user}:publish:${tracks.map((t) => t.source).join(',')}`);
        const s = this.own(g, user, 'pub');
        if (this.listeners.has(user)) throw new Error('forbidden');
        const offer = parseFakeSdp(sdp);
        const named = tracks.map((t) => {
          if (!offer.mids.some((m) => m.mid === t.mid)) throw new Error('mid not in offer');
          const name = `${s.room}.${t.source}.${Math.random().toString(36).slice(2, 12)}`;
          s.published.set(t.mid, { mid: t.mid, name, source: t.source, closed: false });
          return { mid: t.mid, source: t.source, name };
        });
        return { sdp: fakeSdp({ type: 'answer', mids: offer.mids }), tracks: named };
      },
      unpublish: async (g, sdp, mids) => {
        this.calls.push(`${user}:unpublish`);
        const s = this.own(g, user, 'pub');
        for (const m of mids) {
          const t = s.published.get(m);
          if (t) t.closed = true;
        }
        return { sdp: fakeSdp({ type: 'answer', mids: parseFakeSdp(sdp).mids }) };
      },
      subscribe: async (g, tracks) => {
        this.calls.push(`${user}:subscribe:${tracks.length}`);
        const s = this.own(g, user, 'sub');
        const result = tracks.map((t) => {
          if (!t.name.startsWith(s.room + '.')) throw Object.assign(new Error('forbidden'), { status: 403 });
          const src = this.sessions.get(t.session);
          const pubT = src && [...src.published.values()].find((p) => p.name === t.name && !p.closed);
          if (!pubT) return { name: t.name, error: 'not_found' };
          const mid = String(s.nextMid++);
          s.pulled.set(mid, { name: t.name, closed: false });
          return { name: t.name, mid };
        });
        const mids = [...s.pulled.entries()].map(([mid, p]) => ({
          mid,
          kind: (/\.(mic|screenAudio)\./.test(p.name) ? 'audio' : 'video') as 'audio' | 'video',
          stopped: p.closed,
        }));
        const any = result.some((r) => r.mid);
        return { sdp: any ? fakeSdp({ type: 'offer', mids }) : null, renegotiate: any, tracks: result };
      },
      answer: async (g) => {
        this.calls.push(`${user}:answer`);
        this.own(g, user, 'sub');
      },
      unsubscribe: async (g, sdp, mids) => {
        this.calls.push(`${user}:unsubscribe`);
        const s = this.own(g, user, 'sub');
        for (const m of mids) {
          const p = s.pulled.get(m);
          if (p) p.closed = true;
        }
        return { sdp: fakeSdp({ type: 'answer', mids: parseFakeSdp(sdp).mids }) };
      },
      close: async (pub, sub) => {
        this.calls.push(`${user}:close`);
        if (pub) {
          const s = this.own(pub.session, user, 'pub');
          for (const m of pub.mids) {
            const t = s.published.get(m);
            if (t) t.closed = true;
          }
        }
        if (sub) {
          const s = this.own(sub.session, user, 'sub');
          for (const m of sub.mids) {
            const p = s.pulled.get(m);
            if (p) p.closed = true;
          }
        }
      },
    };
  }
}
