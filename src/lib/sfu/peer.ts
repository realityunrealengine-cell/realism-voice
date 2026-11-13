// WebRTC-соединения с Cloudflare Realtime SFU.
//
// У участника два независимых RTCPeerConnection (как в официальном примере video-room):
//   * Publisher — отправляет свои треки (микрофон, камера, экран, звук экрана) в сессию публикации;
//     предложение SDP делает клиент, SFU отвечает (POST tracks/new).
//   * Subscriber — принимает треки остальных в сессию приёма; предложение SDP делает SFU,
//     клиент отвечает (PUT renegotiate).
// Все изменения одной сессии строго последовательны (требование API SFU) — очередь SerialQueue.
import type { SessionGrant, VoiceApi } from './api';
import { diffSubscriptions, MAX_TRACKS_PER_REQUEST, type PublishedTrack, type RemoteTrackRef, type Source } from './protocol';

export interface IceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type PcFactory = (config: RTCConfiguration) => RTCPeerConnection;

export const defaultPcFactory: PcFactory = (config) => new RTCPeerConnection(config);

export function rtcConfig(iceServers: IceServerLike[] | null | undefined): RTCConfiguration {
  return {
    iceServers: iceServers?.length ? iceServers : [{ urls: 'stun:stun.cloudflare.com:3478' }],
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  };
}

/** Последовательное выполнение асинхронных операций */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(
      () => (this.closed ? Promise.reject(new ClosedError()) : fn()),
      () => (this.closed ? Promise.reject(new ClosedError()) : fn()),
    );
    this.tail = next.catch(() => undefined);
    return next;
  }

  close() {
    this.closed = true;
  }

  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}

export class ClosedError extends Error {
  constructor() {
    super('peer connection closed');
    this.name = 'ClosedError';
  }
}

/**
 * Включить DTX для Opus: в тишине (шлюз микрофона закрыт, микрофон выключен) отправляются редкие
 * служебные пакеты вместо 50 пакетов в секунду. Пакеты продолжают идти, поэтому SFU не удаляет трек
 * (он удаляет треки без пакетов дольше 30 с), а исходящий трафик SFU к слушателям заметно меньше.
 */
export function enableOpusDtx(sdp: string): string {
  const m = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp);
  if (!m) return sdp;
  const pt = m[1];
  const re = new RegExp(`^a=fmtp:${pt} (.*)$`, 'm');
  const fm = re.exec(sdp);
  if (!fm) return sdp;
  if (/usedtx=/.test(fm[1])) return sdp;
  return sdp.replace(re, `a=fmtp:${pt} ${fm[1]};usedtx=1`);
}

function waitStable(pc: RTCPeerConnection, timeoutMs = 15_000): Promise<void> {
  if (pc.signalingState === 'stable') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pc.removeEventListener('signalingstatechange', on);
      reject(new Error('WebRTC: согласование не завершилось'));
    }, timeoutMs);
    const on = () => {
      if (pc.signalingState !== 'stable') return;
      clearTimeout(t);
      pc.removeEventListener('signalingstatechange', on);
      resolve();
    };
    pc.addEventListener('signalingstatechange', on);
  });
}

export interface PublishItem {
  source: Source;
  track: MediaStreamTrack;
  encoding?: RTCRtpEncodingParameters;
}

interface Published {
  name: string;
  mid: string;
  transceiver: RTCRtpTransceiver;
}

/** Отправка собственных треков в сессию публикации SFU */
export class Publisher {
  readonly pc: RTCPeerConnection;
  private readonly q = new SerialQueue();
  private readonly bySource = new Map<Source, Published>();
  private closed = false;

  constructor(
    private readonly api: VoiceApi,
    readonly session: SessionGrant,
    config: RTCConfiguration,
    factory: PcFactory,
  ) {
    this.pc = factory(config);
  }

  get sessionId(): string {
    return this.session.id;
  }

  tracks(): PublishedTrack[] {
    return [...this.bySource.entries()].map(([source, p]) => ({ source, name: p.name }));
  }

  has(source: Source): boolean {
    return this.bySource.has(source);
  }

  publish(items: PublishItem[]): Promise<void> {
    return this.q.run(async () => {
      const fresh = items.filter((i) => !this.bySource.has(i.source));
      if (!fresh.length) return;
      await waitStable(this.pc);
      const trs = fresh.map((i) =>
        this.pc.addTransceiver(i.track, { direction: 'sendonly', sendEncodings: i.encoding ? [i.encoding] : undefined }),
      );
      const offer = await this.pc.createOffer();
      const sdp = enableOpusDtx(offer.sdp ?? '');
      await this.pc.setLocalDescription({ type: 'offer', sdp });
      const tracks = fresh.map((i, n) => {
        const mid = trs[n].mid;
        if (!mid) throw new Error('WebRTC: трансиверу не назначен mid');
        return { mid, source: i.source };
      });
      if (this.closed) throw new ClosedError();
      const res = await this.api.publish(this.session, this.pc.localDescription?.sdp ?? sdp, tracks);
      if (this.closed) throw new ClosedError();
      await this.pc.setRemoteDescription({ type: 'answer', sdp: res.sdp });
      for (const t of res.tracks) {
        const n = tracks.findIndex((x) => x.mid === t.mid);
        if (n >= 0) this.bySource.set(fresh[n].source, { name: t.name, mid: t.mid, transceiver: trs[n] });
      }
    });
  }

  unpublish(sources: Source[]): Promise<void> {
    return this.q.run(async () => {
      const list = sources.map((s) => [s, this.bySource.get(s)] as const).filter((x): x is readonly [Source, Published] => !!x[1]);
      if (!list.length) return;
      await waitStable(this.pc);
      for (const [s, p] of list) {
        p.transceiver.stop();
        this.bySource.delete(s);
      }
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      const res = await this.api.unpublish(this.session, this.pc.localDescription?.sdp ?? offer.sdp ?? '', list.map(([, p]) => p.mid));
      if (this.closed) return;
      await this.pc.setRemoteDescription({ type: 'answer', sdp: res.sdp });
    });
  }

  /** Замена источника без согласования (другое устройство ввода) */
  async replace(source: Source, track: MediaStreamTrack | null): Promise<void> {
    const p = this.bySource.get(source);
    if (p) await p.transceiver.sender.replaceTrack(track);
  }

  sender(source: Source): RTCRtpSender | null {
    return this.bySource.get(source)?.transceiver.sender ?? null;
  }

  /** Закрыть соединение; вернуть mid для принудительного закрытия треков в SFU */
  close(): string[] {
    if (this.closed) return [];
    this.closed = true;
    this.q.close();
    const mids = [...this.bySource.values()].map((p) => p.mid);
    this.bySource.clear();
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
    return mids;
  }
}

export interface SubscriberEvents {
  onTrack(ref: RemoteTrackRef, track: MediaStreamTrack, receiver: RTCRtpReceiver): void;
  onTrackGone(ref: RemoteTrackRef): void;
  onError(e: unknown): void;
}

interface Subscription {
  ref: RemoteTrackRef;
  mid: string;
  transceiver: RTCRtpTransceiver | null;
}

/** Приём треков остальных участников из сессии приёма SFU */
export class Subscriber {
  private pcInst: RTCPeerConnection | null = null;
  private readonly q = new SerialQueue();
  private readonly subs = new Map<string, Subscription>();
  private readonly byMid = new Map<string, RemoteTrackRef>();
  private desired: RemoteTrackRef[] = [];
  private running = false;
  private again = false;
  private closed = false;
  private retryAt = new Map<string, { at: number; n: number }>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  onPcCreated: ((pc: RTCPeerConnection) => void) | null = null;

  constructor(
    private readonly api: VoiceApi,
    readonly session: SessionGrant,
    private readonly config: RTCConfiguration,
    private readonly factory: PcFactory,
    private readonly ev: SubscriberEvents,
  ) {}

  get pc(): RTCPeerConnection | null {
    return this.pcInst;
  }

  subscribed(): string[] {
    return [...this.subs.keys()];
  }

  private ensurePc(): RTCPeerConnection {
    if (this.pcInst) return this.pcInst;
    const pc = this.factory(this.config);
    pc.addEventListener('track', (e) => {
      if (this.closed) return;
      const mid = e.transceiver?.mid;
      const ref = mid ? this.byMid.get(mid) : undefined;
      if (!ref) return;
      const sub = this.subs.get(ref.name);
      if (sub) sub.transceiver = e.transceiver;
      this.ev.onTrack(ref, e.track, e.receiver);
    });
    this.pcInst = pc;
    this.onPcCreated?.(pc);
    return pc;
  }

  /** Новый желаемый набор подписок; синхронизация выполняется последовательно и объединяется */
  setDesired(list: RemoteTrackRef[]) {
    this.desired = list;
    void this.kick();
  }

  private async kick(): Promise<void> {
    if (this.closed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.q.run(() => this.syncOnce());
      } while (this.again && !this.closed);
    } catch (e) {
      if (!(e instanceof ClosedError) && !this.closed) this.ev.onError(e);
    } finally {
      this.running = false;
    }
  }

  private async syncOnce(): Promise<void> {
    const { add, remove } = diffSubscriptions(this.subs.keys(), this.desired);
    if (remove.length && this.pcInst) {
      const pc = this.pcInst;
      await waitStable(pc);
      const gone = remove.map((n) => this.subs.get(n)!).filter(Boolean);
      for (const s of gone) {
        try {
          s.transceiver?.stop();
        } catch {
          /* ignore */
        }
        this.subs.delete(s.ref.name);
        this.byMid.delete(s.mid);
        this.ev.onTrackGone(s.ref);
      }
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await this.api.unsubscribe(this.session, pc.localDescription?.sdp ?? offer.sdp ?? '', gone.map((s) => s.mid));
      if (this.closed) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: res.sdp });
    } else {
      for (const n of remove) this.subs.delete(n);
    }

    const now = Date.now();
    const ready = add.filter((a) => (this.retryAt.get(a.name)?.at ?? 0) <= now);
    for (let i = 0; i < ready.length; i += MAX_TRACKS_PER_REQUEST) {
      const batch = ready.slice(i, i + MAX_TRACKS_PER_REQUEST);
      const pc = this.ensurePc();
      await waitStable(pc);
      const res = await this.api.subscribe(
        this.session,
        batch.map((b) => ({ session: b.session, name: b.name })),
      );
      if (this.closed) return;
      for (const r of res.tracks) {
        const ref = batch.find((b) => b.name === r.name);
        if (!ref) continue;
        if (r.mid && !r.error) {
          this.subs.set(ref.name, { ref, mid: r.mid, transceiver: null });
          this.byMid.set(r.mid, ref);
          this.retryAt.delete(ref.name);
        } else {
          // Трек ещё не готов у SFU (публикация только что началась) — повторим с паузой
          const prev = this.retryAt.get(ref.name)?.n ?? 0;
          this.retryAt.set(ref.name, { at: Date.now() + Math.min(1000 * 2 ** prev, 8000), n: prev + 1 });
        }
      }
      if (res.renegotiate && res.sdp) {
        await pc.setRemoteDescription({ type: 'offer', sdp: res.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (this.closed) return;
        await this.api.answer(this.session, pc.localDescription?.sdp ?? answer.sdp ?? '');
      }
    }
    for (const name of this.retryAt.keys()) if (!this.desired.some((d) => d.name === name)) this.retryAt.delete(name);
    this.scheduleRetry();
  }

  private scheduleRetry() {
    if (this.retryTimer || this.closed || this.retryAt.size === 0) return;
    const next = Math.min(...[...this.retryAt.values()].map((r) => r.at));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.kick();
    }, Math.max(100, next - Date.now()));
  }

  /** Приёмник звука участника (для индикатора «говорит») */
  receivers(): { ref: RemoteTrackRef; receiver: RTCRtpReceiver }[] {
    const out: { ref: RemoteTrackRef; receiver: RTCRtpReceiver }[] = [];
    for (const s of this.subs.values()) if (s.transceiver) out.push({ ref: s.ref, receiver: s.transceiver.receiver });
    return out;
  }

  close(): string[] {
    if (this.closed) return [];
    this.closed = true;
    this.q.close();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const mids = [...this.subs.values()].map((s) => s.mid);
    for (const s of this.subs.values()) this.ev.onTrackGone(s.ref);
    this.subs.clear();
    this.byMid.clear();
    try {
      this.pcInst?.close();
    } catch {
      /* ignore */
    }
    return mids;
  }
}
