// Прямой канал сообщений между двумя устройствами: RTCPeerConnection с одним DataChannel.
//
//   1. Сигнализация (SDP, ICE) — через приватный канал Supabase Realtime переписки (dm:<id>).
//   2. ICE — только STUN: для сообщений TURN не используется; если прямой путь невозможен,
//      сообщение уходит через сервер (режим Auto) или ждёт в очереди (режим «Только P2P»).
//   3. После открытия DataChannel — гибридный обмен ключами X-Wing (X25519 + ML-KEM-768), см. crypto.ts.
//      До его завершения прикладные данные не передаются. Ключ меняется каждые REKEY_MS / REKEY_FRAMES.
//   4. Прикладные кадры: AES-256-GCM, счётчик против повтора, выравнивание длины.
//   5. Подлинность (1.3.1): инициатор подписывает свой эфемерный ключ, ответчик — весь transcript, ключом
//      устройства Ed25519 + ML-DSA-65. Неподписанный или чужой обмен отклоняется; ключ собеседника
//      проверяется по списку доверия (verifyPeer) и не может смениться внутри одного соединения.
import {
  answerHandshake, dtlsFingerprint, finishHandshake, fromB64, initSigningPayload, replySigningPayload, ReplayError, SecureSession, startHandshake, toB64,
  type HandshakeInit,
} from './crypto';
import { decodePublic, decodeSig, encodePublic, encodeSig, fingerprint, publicOf, signHybrid, verifyHybrid, type DeviceIdentity, type PublicIdentity } from './identity';
import { linkSnapshot, type LinkSnapshot } from './linkStats';

export interface LinkSignal {
  sdp?: { type: 'offer' | 'answer'; sdp: string };
  cand?: RTCIceCandidateInit | null;
  bye?: boolean;
  /** Ответчик готов: инициатор повторяет предложение, если ответа на него ещё нет (оно могло потеряться) */
  hello?: boolean;
}

export type MsgLinkState = 'connecting' | 'secure' | 'failed' | 'closed';

export interface MsgLinkOptions {
  /** Эта сторона начинает обмен ключами (и делает SDP offer) */
  initiator: boolean;
  config: RTCConfiguration;
  send: (s: LinkSignal) => void;
  onState: (s: MsgLinkState) => void;
  onMessage: (obj: Record<string, unknown>) => void;
  /** Байты зашифрованных кадров, реально прошедших через DataChannel */
  onBytes?: (sent: number, received: number) => void;
  pcFactory?: (c: RTCConfiguration) => RTCPeerConnection;
  log?: (m: string) => void;
  connectTimeoutMs?: number;
  /** Ключ этого устройства (подпись обмена ключами) */
  identity: DeviceIdentity;
  /** Разрешено ли соединение с устройством с таким ключом (список доверия) */
  verifyPeer: (pub: PublicIdentity) => boolean;
}

export const REKEY_MS = 30 * 60_000;
export const REKEY_FRAMES = 5_000;
const MAX_FRAME = 64 * 1024;
/** Сообщения обмена ключами с подписями ML-DSA-65 занимают около 9 КБ */
const MAX_HANDSHAKE = 24 * 1024;

export class MsgLink {
  readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private sentCandidates: (RTCIceCandidateInit | null)[] = [];
  private makingOffer = false;
  private ignoreOffer = false;
  private closed = false;
  private st: MsgLinkState = 'connecting';
  private session: SecureSession | null = null;
  private pendingInit: { init: HandshakeInit; secretKey: Uint8Array; epoch: number } | null = null;
  private queue: Promise<void> = Promise.resolve();
  private rxQueue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rekeyTimer: ReturnType<typeof setInterval> | null = null;
  private peer: PublicIdentity | null = null;

  constructor(private readonly o: MsgLinkOptions) {
    this.pc = (o.pcFactory ?? ((c) => new RTCPeerConnection(c)))(o.config);
    // Канал и SDP-предложение создаёт только инициатор, ответчик лишь отвечает. Встречных предложений
    // нет: при откате (rollback) встречного предложения Chromium иногда так и не открывал DataChannel —
    // найдено реальной проверкой (обе стороны ждали до таймаута).
    if (o.initiator) {
      this.attach(this.pc.createDataChannel('rv-msg', { ordered: true }));
      this.pc.onnegotiationneeded = () => void this.negotiate();
    } else {
      this.pc.ondatachannel = (e) => {
        if (!this.dc && e.channel.label === 'rv-msg') this.attach(e.channel);
      };
      queueMicrotask(() => !this.closed && o.send({ hello: true }));
    }
    this.pc.onicecandidate = (e) => {
      if (this.closed) return;
      const c = e.candidate ? e.candidate.toJSON() : null;
      this.sentCandidates.push(c);
      o.send({ cand: c });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed') this.fail('ice failed');
    };
    this.timer = setTimeout(() => {
      if (this.st === 'connecting') this.fail('timeout');
    }, o.connectTimeoutMs ?? 20_000);
  }

  private attach(dc: RTCDataChannel) {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => this.onOpen();
    dc.onclose = () => this.fail('channel closed');
    dc.onmessage = (e) => this.onData(e.data);
    if (dc.readyState === 'open') this.onOpen();
  }

  get state(): MsgLinkState {
    return this.st;
  }

  get keyId(): string | null {
    return this.session?.keyId ?? null;
  }

  /** Подтверждённый подписью ключ устройства собеседника */
  get peerIdentity(): PublicIdentity | null {
    return this.peer;
  }

  /** Подпись проверена; ключ тот же, что раньше в этом соединении, и разрешён списком доверия */
  private acceptPeer(pubRaw: unknown, sigRaw: unknown, payload: Uint8Array): boolean {
    const pub = decodePublic(pubRaw);
    const sig = decodeSig(sigRaw);
    if (!pub || !sig || !verifyHybrid(pub, payload, sig)) {
      this.fail('handshake signature invalid');
      return false;
    }
    if (this.peer && fingerprint(this.peer) !== fingerprint(pub)) {
      this.fail('peer identity changed inside connection');
      return false;
    }
    if (!this.o.verifyPeer(pub)) {
      this.fail('peer identity not trusted');
      return false;
    }
    this.peer = pub;
    return true;
  }

  private setState(s: MsgLinkState) {
    if (this.st === s || this.st === 'closed' || this.st === 'failed') return;
    this.st = s;
    this.o.onState(s);
  }

  private async negotiate() {
    if (this.closed) return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      const d = this.pc.localDescription;
      if (d && !this.closed) this.o.send({ sdp: { type: d.type as 'offer', sdp: d.sdp } });
    } catch (e) {
      this.o.log?.(`msg link: offer failed ${(e as Error)?.message}`);
    } finally {
      this.makingOffer = false;
    }
  }

  handle(s: LinkSignal) {
    this.queue = this.queue.then(() => this.handleNow(s)).catch((e) => this.o.log?.(`msg link: signal error ${(e as Error)?.message}`));
  }

  private async handleNow(s: LinkSignal) {
    if (this.closed) return;
    if (s.bye) {
      this.fail('peer closed');
      return;
    }
    if (s.hello) {
      // Предложение могло уйти до того, как ответчик подключился к каналу сигнализации
      const d = this.pc.localDescription;
      if (this.o.initiator && d && this.pc.signalingState === 'have-local-offer') {
        this.o.send({ sdp: { type: 'offer', sdp: d.sdp } });
        for (const c of this.sentCandidates) this.o.send({ cand: c });
      }
      return;
    }
    if (s.sdp) {
      const d = s.sdp;
      if ((d.type !== 'offer' && d.type !== 'answer') || typeof d.sdp !== 'string' || d.sdp.length > 100_000) return;
      // Предложения принимает только ответчик; ответы — только инициатор
      this.ignoreOffer = d.type === 'offer' ? this.o.initiator : !this.o.initiator;
      if (this.ignoreOffer) return;
      if (d.type === 'answer' && this.pc.signalingState !== 'have-local-offer') return;
      await this.pc.setRemoteDescription(d);
      if (d.type === 'offer') {
        await this.pc.setLocalDescription();
        const a = this.pc.localDescription;
        if (a && !this.closed) this.o.send({ sdp: { type: 'answer', sdp: a.sdp } });
      }
      return;
    }
    if (s.cand !== undefined) {
      try {
        await this.pc.addIceCandidate(s.cand ?? undefined);
      } catch (e) {
        if (!this.ignoreOffer) this.o.log?.(`msg link: candidate rejected ${(e as Error)?.message}`);
      }
    }
  }

  /** Отпечатки DTLS в порядке «инициатор, ответчик» — входят в transcript обмена ключами */
  private fingerprints(): [string, string] {
    const local = dtlsFingerprint(this.pc.localDescription?.sdp);
    const remote = dtlsFingerprint(this.pc.remoteDescription?.sdp);
    return this.o.initiator ? [local, remote] : [remote, local];
  }

  private onOpen() {
    if (this.closed) return;
    if (this.o.initiator) this.beginHandshake(1);
  }

  private beginHandshake(epoch: number) {
    const { init, secretKey } = startHandshake();
    this.pendingInit = { init, secretKey, epoch };
    const [fpI, fpR] = this.fingerprints();
    const sig = signHybrid(this.o.identity, initSigningPayload(epoch, fpI, fpR, init));
    this.sendPlain({ hs: 1, epoch, pk: toB64(init.pk), nonce: toB64(init.nonce), id: encodePublic(publicOf(this.o.identity)), sig: encodeSig(sig) });
  }

  private sendPlain(obj: Record<string, unknown>) {
    if (!this.dc || this.dc.readyState !== 'open') return;
    const s = JSON.stringify(obj);
    this.dc.send(s);
    this.o.onBytes?.(s.length, 0);
  }

  private onData(data: unknown) {
    this.rxQueue = this.rxQueue.then(() => this.onDataNow(data)).catch((e) => {
      if (e instanceof ReplayError) this.o.log?.('msg link: replayed frame dropped');
      else this.o.log?.(`msg link: bad frame ${(e as Error)?.message}`);
    });
  }

  private async onDataNow(data: unknown) {
    if (this.closed) return;
    if (typeof data === 'string') {
      this.o.onBytes?.(0, data.length);
      if (data.length > MAX_HANDSHAKE) return;
      const m = JSON.parse(data) as { hs?: number; epoch?: number; pk?: string; ct?: string; nonce?: string; id?: unknown; sig?: unknown };
      const epoch = typeof m.epoch === 'number' && Number.isInteger(m.epoch) && m.epoch > 0 && m.epoch < 1e6 ? m.epoch : 0;
      if (!epoch) return;
      const [fpI, fpR] = this.fingerprints();
      if (m.hs === 1 && !this.o.initiator && typeof m.pk === 'string' && typeof m.nonce === 'string') {
        if (this.session && epoch <= this.session.epoch) return;
        const init = { pk: fromB64(m.pk), nonce: fromB64(m.nonce) };
        if (!this.acceptPeer(m.id, m.sig, initSigningPayload(epoch, fpI, fpR, init))) return;
        const { reply, keys } = await answerHandshake(init, epoch, fpI, fpR);
        const sig = signHybrid(this.o.identity, replySigningPayload(keys.transcript));
        this.sendPlain({ hs: 2, epoch, ct: toB64(reply.ct), nonce: toB64(reply.nonce), id: encodePublic(publicOf(this.o.identity)), sig: encodeSig(sig) });
        this.installKeys(keys);
      } else if (m.hs === 2 && this.o.initiator && this.pendingInit && epoch === this.pendingInit.epoch && typeof m.ct === 'string' && typeof m.nonce === 'string') {
        const p = this.pendingInit;
        this.pendingInit = null;
        const keys = await finishHandshake(p.init, p.secretKey, { ct: fromB64(m.ct), nonce: fromB64(m.nonce) }, epoch, fpI, fpR);
        if (!this.acceptPeer(m.id, m.sig, replySigningPayload(keys.transcript))) return;
        this.installKeys(keys);
      }
      return;
    }
    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : null;
    if (!buf || !this.session || buf.length > MAX_FRAME) return;
    this.o.onBytes?.(0, buf.length);
    const obj = await this.session.open(buf);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) this.o.onMessage(obj as Record<string, unknown>);
  }

  private installKeys(keys: Awaited<ReturnType<typeof finishHandshake>>) {
    if (this.closed) return;
    if (this.session) this.session.rekey(keys);
    else this.session = new SecureSession(keys);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.o.log?.(`msg link: secure (epoch ${keys.epoch})`);
    if (this.o.initiator && !this.rekeyTimer) {
      this.rekeyTimer = setInterval(() => {
        const s = this.session;
        if (!s || this.closed || this.pendingInit) return;
        if (Date.now() - s.establishedAt > REKEY_MS || s.framesSinceRekey > REKEY_FRAMES) this.beginHandshake(s.epoch + 1);
      }, 60_000);
    }
    this.setState('secure');
  }

  /** Принудительная смена ключа (для проверки и после смены сети) */
  rekeyNow() {
    if (this.o.initiator && this.session && !this.pendingInit) this.beginHandshake(this.session.epoch + 1);
  }

  async send(obj: Record<string, unknown>): Promise<boolean> {
    const s = this.session;
    const dc = this.dc;
    if (!s || this.closed || !dc || dc.readyState !== 'open') return false;
    const frame = await s.seal(obj);
    if (frame.length > MAX_FRAME || dc.readyState !== 'open') return false;
    dc.send(frame as Uint8Array<ArrayBuffer>);
    this.o.onBytes?.(frame.length, 0);
    return true;
  }

  async snapshot(): Promise<LinkSnapshot | null> {
    if (this.closed) return null;
    try {
      return await linkSnapshot(this.pc);
    } catch {
      return null;
    }
  }

  private fail(reason: string) {
    if (this.closed) return;
    this.o.log?.(`msg link: ${reason}`);
    this.setState('failed');
    this.close(false);
  }

  close(notify = true) {
    if (this.closed) return;
    if (notify) this.o.send({ bye: true });
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.rekeyTimer) clearInterval(this.rekeyTimer);
    this.pendingInit?.secretKey.fill(0);
    this.pendingInit = null;
    if (this.st !== 'failed') {
      this.st = 'closed';
      this.o.onState('closed');
    }
    try {
      this.dc?.close();
      this.pc.close();
    } catch {
      /* уже закрыто */
    }
  }
}
