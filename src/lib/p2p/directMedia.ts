// Прямое (P2P) медиасоединение двух устройств для личного звонка — без Cloudflare SFU.
//
// Согласование — шаблон «perfect negotiation» (W3C WebRTC): обе стороны могут менять набор треков,
// встречные предложения разрешаются ролями polite / impolite. Сигнализация (SDP и ICE-кандидаты)
// идёт через приватный канал Supabase Realtime звонка (dm:<id>), доступный только двум участникам.
//
// ICE: STUN Cloudflare для прямого соединения через NAT; TURN (если выдан Edge Function voice-sfu)
// — резерв, когда прямой путь невозможен (симметричный NAT, CGNAT, закрытый UDP). Какой путь
// выбран на самом деле, показывает getStats() (см. linkStats.ts) — тип в интерфейсе не «угадывается».
//
// Источник трека (микрофон, камера, экран, звук экрана) передаётся картой «id потока → источник»
// вместе с каждым SDP: у каждого источника свой MediaStream.
import type { Source } from '@/lib/sfu/protocol';
import { SOURCES } from '@/lib/sfu/protocol';
import { linkSnapshot, type LinkSnapshot } from './linkStats';

export interface MediaSignal {
  sdp?: { type: 'offer' | 'answer'; sdp: string };
  map?: Record<string, Source>;
  cand?: RTCIceCandidateInit | null;
  bye?: boolean;
}

export type DirectState = 'connecting' | 'connected' | 'failed' | 'closed';

export interface DirectMediaOptions {
  polite: boolean;
  config: RTCConfiguration;
  send: (msg: MediaSignal) => void;
  onState: (s: DirectState) => void;
  onTrack: (source: Source, track: MediaStreamTrack | null) => void;
  pcFactory?: (c: RTCConfiguration) => RTCPeerConnection;
  log?: (m: string) => void;
  /** Сколько ждать восстановления после обрыва (ICE restart), прежде чем считать связь потерянной */
  restartGraceMs?: number;
}

export interface LocalItem {
  track: MediaStreamTrack;
  encoding?: { maxBitrate?: number; maxFramerate?: number };
}

const isSource = (v: unknown): v is Source => SOURCES.includes(v as Source);

export class DirectMedia {
  readonly pc: RTCPeerConnection;
  private makingOffer = false;
  private ignoreOffer = false;
  private closed = false;
  private state: DirectState = 'connecting';
  private readonly senders = new Map<Source, { sender: RTCRtpSender; stream: MediaStream; encoding?: LocalItem['encoding'] }>();
  private remoteMap: Record<string, Source> = {};
  private readonly remote = new Map<Source, { track: MediaStreamTrack; receiver: RTCRtpReceiver }>();
  private discTimer: ReturnType<typeof setTimeout> | null = null;
  private restarted = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly o: DirectMediaOptions) {
    this.pc = (o.pcFactory ?? ((c) => new RTCPeerConnection(c)))(o.config);
    const pc = this.pc;
    pc.onnegotiationneeded = () => void this.negotiate();
    pc.onicecandidate = (e) => {
      if (!this.closed) o.send({ cand: e.candidate ? e.candidate.toJSON() : null });
    };
    pc.ontrack = (e) => this.onRemoteTrack(e);
    pc.onconnectionstatechange = () => this.onConnState();
  }

  get connected(): boolean {
    return this.state === 'connected';
  }

  get current(): DirectState {
    return this.state;
  }

  private setState(s: DirectState) {
    if (this.state === s || this.state === 'closed') return;
    this.state = s;
    this.o.onState(s);
  }

  private onConnState() {
    if (this.closed) return;
    const st = this.pc.connectionState;
    this.o.log?.(`direct: ${st}`);
    if (st === 'connected') {
      if (this.discTimer) clearTimeout(this.discTimer);
      this.discTimer = null;
      this.restarted = false;
      this.setState('connected');
      void this.applyEncodings();
      return;
    }
    if (st === 'closed') {
      // Соединение закрыто не нами (сбой процесса WebRTC) — восстановить нельзя
      this.setState('failed');
      return;
    }
    if (st === 'failed' || st === 'disconnected') {
      // Обрыв: одна попытка ICE restart (новые пути, в т.ч. TURN), затем — «связь потеряна»
      if (!this.restarted) {
        this.restarted = true;
        try {
          this.pc.restartIce();
        } catch {
          /* закрыто */
        }
      }
      if (!this.discTimer) {
        this.discTimer = setTimeout(() => {
          this.discTimer = null;
          if (!this.closed && this.pc.connectionState !== 'connected') this.setState('failed');
        }, this.o.restartGraceMs ?? 8_000);
      }
    }
  }

  private localMap(): Record<string, Source> {
    const map: Record<string, Source> = {};
    for (const [source, s] of this.senders) map[s.stream.id] = source;
    return map;
  }

  private async negotiate() {
    if (this.closed) return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      const d = this.pc.localDescription;
      if (d && !this.closed) this.o.send({ sdp: { type: d.type as 'offer', sdp: d.sdp }, map: this.localMap() });
    } catch (e) {
      this.o.log?.(`direct: offer failed ${(e as Error)?.message}`);
    } finally {
      this.makingOffer = false;
    }
  }

  /** Входящие сообщения сигнализации обрабатываются строго по очереди */
  handle(msg: MediaSignal): void {
    this.queue = this.queue.then(() => this.handleNow(msg)).catch((e) => this.o.log?.(`direct: signal error ${(e as Error)?.message}`));
  }

  private async handleNow(msg: MediaSignal) {
    if (this.closed) return;
    if (msg.bye) {
      this.setState('failed');
      return;
    }
    if (msg.map && typeof msg.map === 'object') {
      const clean: Record<string, Source> = {};
      for (const [k, v] of Object.entries(msg.map)) if (typeof k === 'string' && k.length <= 128 && isSource(v)) clean[k] = v;
      this.remoteMap = clean;
    }
    if (msg.sdp) {
      const d = msg.sdp;
      if ((d.type !== 'offer' && d.type !== 'answer') || typeof d.sdp !== 'string' || d.sdp.length > 200_000) return;
      const collision = d.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
      this.ignoreOffer = !this.o.polite && collision;
      if (this.ignoreOffer) return;
      await this.pc.setRemoteDescription(d);
      if (d.type === 'offer') {
        await this.pc.setLocalDescription();
        const a = this.pc.localDescription;
        if (a && !this.closed) this.o.send({ sdp: { type: 'answer', sdp: a.sdp }, map: this.localMap() });
      }
      this.reconcileRemote();
      void this.applyEncodings();
      return;
    }
    if (msg.cand !== undefined) {
      try {
        await this.pc.addIceCandidate(msg.cand ?? undefined);
      } catch (e) {
        if (!this.ignoreOffer) this.o.log?.(`direct: candidate rejected ${(e as Error)?.message}`);
      }
    }
  }

  private onRemoteTrack(e: RTCTrackEvent) {
    if (this.closed) return;
    const streamId = e.streams[0]?.id;
    const source = streamId ? this.remoteMap[streamId] : undefined;
    if (!source) {
      this.o.log?.(`direct: track without source map (${streamId})`);
      return;
    }
    const prev = this.remote.get(source);
    if (prev?.track === e.track) return;
    this.remote.set(source, { track: e.track, receiver: e.receiver });
    e.streams[0]?.addEventListener('removetrack', () => this.reconcileRemote());
    this.o.onTrack(source, e.track);
  }

  /** Треки, которые собеседник перестал отправлять (трансивер больше не принимает) */
  private reconcileRemote() {
    for (const [source, r] of [...this.remote]) {
      const tr = this.pc.getTransceivers().find((t) => t.receiver === r.receiver);
      const dir = tr?.currentDirection;
      const receiving = !!tr && dir !== 'stopped' && (dir === 'recvonly' || dir === 'sendrecv' || dir == null);
      const stillMapped = Object.values(this.remoteMap).includes(source);
      if (!receiving || !stillMapped || r.track.readyState === 'ended') {
        this.remote.delete(source);
        this.o.onTrack(source, null);
      }
    }
  }

  /** Синхронизировать отправляемые треки с набором источников */
  setSources(items: Map<Source, LocalItem>): void {
    if (this.closed) return;
    for (const [source, s] of [...this.senders]) {
      const want = items.get(source);
      if (!want) {
        try {
          this.pc.removeTrack(s.sender);
        } catch {
          /* закрыто */
        }
        this.senders.delete(source);
      } else if (s.sender.track !== want.track) {
        void s.sender.replaceTrack(want.track).catch(() => undefined);
        s.encoding = want.encoding;
      }
    }
    for (const [source, it] of items) {
      if (this.senders.has(source)) continue;
      const stream = new MediaStream([it.track]);
      const sender = this.pc.addTrack(it.track, stream);
      this.senders.set(source, { sender, stream, encoding: it.encoding });
    }
    void this.applyEncodings();
  }

  private async applyEncodings() {
    for (const s of this.senders.values()) {
      if (!s.encoding) continue;
      try {
        const p = s.sender.getParameters();
        if (!p.encodings?.length) continue;
        const e = p.encodings[0];
        if (e.maxBitrate === s.encoding.maxBitrate && e.maxFramerate === s.encoding.maxFramerate) continue;
        if (s.encoding.maxBitrate) e.maxBitrate = s.encoding.maxBitrate;
        if (s.encoding.maxFramerate) e.maxFramerate = s.encoding.maxFramerate;
        await s.sender.setParameters(p);
      } catch {
        /* параметры недоступны до согласования */
      }
    }
  }

  remoteReceivers(): { source: Source; receiver: RTCRtpReceiver }[] {
    return [...this.remote].map(([source, r]) => ({ source, receiver: r.receiver }));
  }

  hasRemote(source: Source): boolean {
    return this.remote.has(source);
  }

  async snapshot(): Promise<LinkSnapshot | null> {
    if (this.closed) return null;
    try {
      return await linkSnapshot(this.pc);
    } catch {
      return null;
    }
  }

  /** Сеть вернулась: если связь не в порядке — новые пути ICE */
  restartIce() {
    if (this.closed || this.pc.connectionState === 'connected') return;
    this.restarted = false;
    try {
      this.pc.restartIce();
    } catch {
      /* закрыто */
    }
  }

  close(notify = true) {
    if (this.closed) return;
    if (notify) this.o.send({ bye: true });
    this.closed = true;
    if (this.discTimer) clearTimeout(this.discTimer);
    for (const source of [...this.remote.keys()]) this.o.onTrack(source, null);
    this.remote.clear();
    this.senders.clear();
    this.state = 'closed';
    try {
      this.pc.close();
    } catch {
      /* уже закрыто */
    }
  }
}
