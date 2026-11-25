// P2P-доставка личных сообщений: обнаружение устройств, прямые каналы, очередь, подтверждения, история.
//
// Обнаружение. Для каждой подходящей переписки (собеседник в сети) хаб входит в приватный канал
// Supabase Realtime `dm:<id>` (доступ только у двух участников — политика realtime_topic_allowed) и
// публикует там presence-запись {uid, p2pm: 1}. Так устройства собеседника (и другие устройства этого же
// пользователя) узнают друг о друге и обмениваются SDP/ICE (broadcast «p2p-msg»). Записи без поля
// user_id голосовые звонки (и старые версии приложения) игнорируют.
//
// Доставка. Каждая операция (сообщение, правка, удаление, реакция) сначала сохраняется в локальную
// очередь (IndexedDB), затем отправляется по всем защищённым каналам к устройствам собеседника.
// Получатель применяет её (без дублей) и отвечает подтверждением; только тогда операция покидает очередь.
// Отключение и повторное подключение: канал пересоздаётся, при открытии отправляется вся очередь и
// выполняется синхронизация истории (обмен списками «id → версия»).
import { SupervisedChannel, type RtClient } from '@/lib/presenceChannel';
import type { Message } from '@/lib/types';
import { MsgLink, type LinkSignal, type MsgLinkState } from './msgLink';
import { applyOp, isUuid, messageData, parseFrame, syncPlan } from './ops';
import { toMessage, type OpKind, type OutboxOp, type P2pStore, type StoredMessage } from './store';
import type { LinkInfo } from '@/stores/netStats';
import type { DeviceIdentity, PublicIdentity } from './identity';

export const SIGNAL_EVENT = 'p2p-msg';
export const ACK_TIMEOUT_MS = 3_000;
const SYNC_LIMIT = 300;
/** Ограничение частоты входящих операций с одного канала (защита от спама) */
const RATE_PER_10S = 200;

export interface HubEnv {
  me: string;
  store: P2pStore;
  rt: () => RtClient & { dispose?: () => void };
  iceServers: RTCIceServer[];
  pcFactory?: (c: RTCConfiguration) => RTCPeerConnection;
  log?: (m: string) => void;
  /** Новое или изменённое сообщение для показа */
  onMessage: (m: Message, fresh: boolean) => void;
  onBytes?: (sent: number, received: number) => void;
  onLinks?: (links: Record<string, LinkInfo>) => void;
  /** Ключ этого устройства */
  identity: DeviceIdentity;
  /** Проверка ключа устройства пользователя по списку доверия (false — соединение запрещено) */
  trust: (userId: string, pub: PublicIdentity) => boolean;
}

export interface RoomSpec {
  dm: string;
  peer: string;
}

interface LinkEntry {
  key: string;
  user: string;
  dev: string;
  link: MsgLink;
  state: MsgLinkState;
  window: number[];
}

interface Room {
  dm: string;
  peer: string;
  ch: SupervisedChannel;
  members: Map<string, { user: string; dev: string }>;
  links: Map<string, LinkEntry>;
  retry: Map<string, { at: number; attempt: number }>;
  pending: { key: string; at: number; s: LinkSignal }[];
}

export type SendOutcome = 'p2p' | 'queued' | 'fallback';

export class P2pHub {
  readonly dev = crypto.randomUUID();
  private client: (RtClient & { dispose?: () => void }) | null = null;
  private rooms = new Map<string, Room>();
  private waiters = new Map<string, (ok: boolean) => void>();
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly env: HubEnv) {
    this.retryTimer = setInterval(() => this.retryLinks(), 5_000);
  }

  get me(): string {
    return this.env.me;
  }

  private log(m: string) {
    this.env.log?.(m);
  }

  // ---------- переписки ----------
  /** Набор переписок, в которых нужно держать P2P-каналы */
  setRooms(specs: RoomSpec[]) {
    if (this.stopped) return;
    const want = new Map(specs.filter((s) => isUuid(s.dm) && isUuid(s.peer)).map((s) => [s.dm, s]));
    for (const [dm, r] of [...this.rooms]) if (!want.has(dm)) this.closeRoom(r);
    for (const s of want.values()) if (!this.rooms.has(s.dm)) this.openRoom(s);
  }

  private openRoom(s: RoomSpec) {
    this.client ??= this.env.rt();
    const room: Room = { dm: s.dm, peer: s.peer, members: new Map(), links: new Map(), retry: new Map(), pending: [], ch: null as unknown as SupervisedChannel };
    room.ch = new SupervisedChannel({
      client: this.client,
      topic: `dm:${s.dm}`,
      // Отдельный ключ presence: записи хаба не путаются с участниками звонка (ключ звонка — id пользователя)
      key: `m:${this.me}`,
      session: this.dev,
      log: this.env.log,
      onSync: (state) => this.onSync(room, state),
      onBroadcast: (event, payload) => {
        if (event === SIGNAL_EVENT) this.onSignal(room, payload);
      },
    });
    room.ch.setPayload({ uid: this.me, p2pm: 1, at: Date.now() });
    room.ch.start();
    this.rooms.set(s.dm, room);
    this.log(`hub: room ${s.dm} opened`);
  }

  private closeRoom(r: Room) {
    this.rooms.delete(r.dm);
    for (const e of r.links.values()) e.link.close(true);
    r.links.clear();
    void r.ch.stop();
    this.publishLinks();
    if (this.rooms.size === 0 && this.client) {
      this.client.dispose?.();
      this.client = null;
    }
  }

  private onSync(room: Room, state: Record<string, Record<string, unknown>[]>) {
    if (!this.rooms.has(room.dm)) return;
    const members = new Map<string, { user: string; dev: string }>();
    for (const metas of Object.values(state)) {
      for (const m of metas ?? []) {
        if (!m || m.p2pm !== 1 || !isUuid(m.uid) || typeof m.session !== 'string' || m.session.length > 64) continue;
        if (m.uid !== room.peer && m.uid !== this.me) continue;
        if (m.uid === this.me && m.session === this.dev) continue;
        members.set(`${m.uid}:${m.session}`, { user: m.uid, dev: m.session });
      }
    }
    room.members = members;
    for (const [key, e] of [...room.links]) {
      if (!members.has(key)) {
        e.link.close(false);
        room.links.delete(key);
        room.retry.delete(key);
      }
    }
    for (const [key, m] of members) if (!room.links.has(key) && !room.retry.has(key)) this.openLink(room, key, m.user, m.dev);
    this.publishLinks();
  }

  private openLink(room: Room, key: string, user: string, dev: string) {
    const initiator = `${this.me}:${this.dev}` < key;
    const entry: LinkEntry = { key, user, dev, state: 'connecting', window: [], link: null as unknown as MsgLink };
    entry.link = new MsgLink({
      initiator,
      identity: this.env.identity,
      verifyPeer: (pub) => this.env.trust(user, pub),
      config: { iceServers: this.env.iceServers, bundlePolicy: 'max-bundle' },
      pcFactory: this.env.pcFactory,
      log: this.env.log,
      send: (s) => {
        room.ch.send(SIGNAL_EVENT, { ...s, from: this.me, fromDev: this.dev, to: user, toDev: dev });
      },
      onBytes: (sent, recv) => this.env.onBytes?.(sent, recv),
      onState: (st) => {
        if (room.links.get(key) !== entry) return;
        entry.state = st;
        if (st === 'secure') {
          room.retry.delete(key);
          void this.onSecure(room, entry);
        } else if (st === 'failed' || st === 'closed') {
          room.links.delete(key);
          const r = room.retry.get(key);
          const attempt = (r?.attempt ?? 0) + 1;
          // Повторы с нарастающей паузой: 5 с, 15 с, 30 с, затем раз в минуту
          room.retry.set(key, { attempt, at: Date.now() + [5_000, 15_000, 30_000, 60_000][Math.min(attempt - 1, 3)] });
        }
        this.publishLinks();
      },
      onMessage: (obj) => void this.onFrame(room, entry, obj),
    });
    room.links.set(key, entry);
    const now = Date.now();
    const pend = room.pending.filter((p) => p.key === key && now - p.at < 15_000);
    room.pending = room.pending.filter((p) => p.key !== key);
    for (const p of pend) entry.link.handle(p.s);
    this.publishLinks();
  }

  private retryLinks() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      for (const [key, r] of [...room.retry]) {
        if (r.at > now || room.links.has(key)) continue;
        const m = room.members.get(key);
        if (!m) {
          room.retry.delete(key);
          continue;
        }
        // Запись о повторе сохраняется (для нарастающей паузы) — удаляется при успехе
        room.retry.set(key, { ...r, at: Number.POSITIVE_INFINITY });
        this.openLink(room, key, m.user, m.dev);
      }
    }
  }

  private onSignal(room: Room, payload: unknown) {
    const p = payload as (LinkSignal & { from?: unknown; fromDev?: unknown; to?: unknown; toDev?: unknown }) | null;
    if (!p || p.to !== this.me || p.toDev !== this.dev || !isUuid(p.from) || typeof p.fromDev !== 'string') return;
    if (p.from !== room.peer && p.from !== this.me) return;
    const key = `${p.from}:${p.fromDev}`;
    const s: LinkSignal = {};
    if (p.sdp) s.sdp = p.sdp;
    if (p.cand !== undefined) s.cand = p.cand;
    if (p.bye === true) s.bye = true;
    if (p.hello === true) s.hello = true;
    const e = room.links.get(key);
    if (e) {
      e.link.handle(s);
      return;
    }
    if (s.bye || s.hello) return;
    // Канал ещё не создан (presence собеседника пришёл позже его предложения) — держим 15 секунд
    if (s.sdp?.type === 'offer' && room.retry.has(key)) {
      // Собеседник начал заново раньше нашей паузы — подключаемся сразу
      room.retry.delete(key);
      const m = room.members.get(key);
      if (m) {
        this.openLink(room, key, m.user, m.dev);
        room.links.get(key)?.link.handle(s);
        return;
      }
    }
    room.pending.push({ key, at: Date.now(), s });
    if (room.pending.length > 200) room.pending.splice(0, room.pending.length - 200);
  }

  // ---------- защищённый канал открыт ----------
  private async onSecure(room: Room, e: LinkEntry) {
    // 1) Синхронизация истории: сообщаем, что у нас есть
    const local = await this.env.store.messagesFor(this.me, room.dm, SYNC_LIMIT);
    await e.link.send({ k: 'have', dm: room.dm, items: local.map((m) => [m.id, m.v]) });
    // 2) Очередь операций для собеседника
    if (e.user === room.peer) {
      for (const op of await this.env.store.outbox(this.me, room.dm)) {
        if (op.to !== room.peer) continue;
        op.attempts++;
        this.env.store.putOp(op);
        await e.link.send({ k: 'op', op: op.op, kind: op.kind, dm: op.dm, data: op.data });
      }
    }
  }

  private rateOk(e: LinkEntry): boolean {
    const now = Date.now();
    e.window = e.window.filter((t) => now - t < 10_000);
    if (e.window.length >= RATE_PER_10S) return false;
    e.window.push(now);
    return true;
  }

  private async onFrame(room: Room, e: LinkEntry, obj: Record<string, unknown>) {
    if (!this.rooms.has(room.dm)) return;
    if (obj.k === 'ack') {
      if (typeof obj.op !== 'string') return;
      // Подтверждение засчитывается только от устройства получателя
      if (e.user !== room.peer) return;
      const ops = await this.env.store.outbox(this.me, room.dm);
      const op = ops.find((o) => o.op === obj.op);
      if (op) {
        this.env.store.removeOp(op.op);
        if (op.kind === 'msg' && isUuid(op.data.id)) await this.markDelivered(op.data.id);
      }
      this.waiters.get(obj.op)?.(true);
      return;
    }
    if (obj.k === 'have') {
      if (obj.dm !== room.dm || !Array.isArray(obj.items)) return;
      const local = await this.env.store.messagesFor(this.me, room.dm, SYNC_LIMIT);
      const plan = syncPlan(local, (obj.items as unknown[]).slice(0, SYNC_LIMIT * 2) as [string, number][], { me: this.me, peer: room.peer, to: e.user });
      for (const m of plan) await e.link.send({ k: 'op', op: `sync:${m.id}:${m.v}`, kind: 'msg', dm: room.dm, data: { ...messageData(m), delivered: m.delivered === true } });
      return;
    }
    const f = parseFrame(obj);
    if (!f) return;
    if (!this.rateOk(e)) {
      this.log('hub: rate limit, frame dropped');
      return;
    }
    const res = await applyOp({ store: this.env.store, me: this.me, dm: room.dm, peer: room.peer, from: e.user }, f);
    if (res.status === 'rejected') {
      this.log(`hub: op rejected (${res.reason})`);
      return;
    }
    // Подтверждаем и повтор (duplicate), и устаревшее — отправитель перестанет повторять
    await e.link.send({ k: 'ack', op: f.op });
    if (res.status === 'applied') {
      // Сообщение собеседника, принятое нами, — значит доставлено; своё с другого устройства — без изменений
      this.env.onMessage(toMessage(res.message), res.fresh);
    }
  }

  private async markDelivered(id: string) {
    const m = await this.env.store.getMessage(id);
    if (!m || m.delivered) return;
    const next = { ...m, delivered: true };
    this.env.store.putMessage(next);
    this.env.onMessage(toMessage(next), false);
  }

  // ---------- отправка ----------
  /** Есть ли сейчас защищённый канал хотя бы к одному устройству собеседника */
  reachable(dm: string): boolean {
    const r = this.rooms.get(dm);
    return !!r && [...r.links.values()].some((e) => e.user === r.peer && e.state === 'secure');
  }

  private async enqueue(dm: string, peer: string, kind: OpKind, data: Record<string, unknown>): Promise<OutboxOp> {
    const op: OutboxOp = { op: crypto.randomUUID(), owner: this.me, dm, to: peer, kind, data, created: Date.now(), attempts: 0 };
    this.env.store.putOp(op);
    const r = this.rooms.get(dm);
    if (r) {
      for (const e of r.links.values()) {
        if (e.state !== 'secure') continue;
        // Собеседнику — как операция с подтверждением; своим другим устройствам — копия для истории
        if (e.user === peer) op.attempts++;
        await e.link.send({ k: 'op', op: e.user === peer ? op.op : `copy:${op.op}`, kind, dm, data });
      }
      if (op.attempts) this.env.store.putOp(op);
    }
    return op;
  }

  private waitAck(op: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters.delete(op);
        resolve(false);
      }, ms);
      this.waiters.set(op, (ok) => {
        clearTimeout(t);
        this.waiters.delete(op);
        resolve(ok);
      });
    });
  }

  /**
   * Отправить сообщение.
   * @param fallbackMs режим Auto: сколько ждать подтверждения, прежде чем вернуть 'fallback' (тогда
   *                   отправитель кладёт сообщение на сервер с тем же id); null — «Только P2P»: ждать в очереди.
   */
  async sendMessage(dm: string, peer: string, msg: { id: string; content: string; reply_to_id: string | null; created_at: string }, fallbackMs: number | null): Promise<SendOutcome> {
    if (fallbackMs !== null && !this.reachable(dm)) return 'fallback';
    const stored: StoredMessage = {
      id: msg.id,
      owner: this.me,
      dm_id: dm,
      author_id: this.me,
      content: msg.content,
      reply_to_id: msg.reply_to_id,
      kind: 'default',
      created_at: msg.created_at,
      edited_at: null,
      deleted_at: null,
      reactions: {},
      v: Date.parse(msg.created_at),
      delivered: false,
    };
    this.env.store.putMessage(stored);
    this.env.onMessage(toMessage(stored), true);
    const op = await this.enqueue(dm, peer, 'msg', messageData(stored));
    if (fallbackMs === null) return 'queued';
    const ok = await this.waitAck(op.op, fallbackMs);
    if (ok) return 'p2p';
    // Не подтверждено — сообщение уходит через сервер; P2P-копия и очередь убираются
    this.env.store.removeOp(op.op);
    this.env.store.deleteMessage(stored.id);
    await this.env.store.flush();
    return 'fallback';
  }

  async edit(dm: string, peer: string, id: string, content: string) {
    await this.localOp(dm, peer, 'edit', { id, content, at: Date.now() });
  }

  async remove(dm: string, peer: string, id: string) {
    await this.localOp(dm, peer, 'del', { id, at: Date.now() });
  }

  async react(dm: string, peer: string, id: string, emoji: string, add: boolean) {
    await this.localOp(dm, peer, 'react', { id, emoji, add, user: this.me, at: Date.now() });
  }

  /** Своя операция: применить локально (по тем же правилам), затем отправить */
  private async localOp(dm: string, peer: string, kind: OpKind, data: Record<string, unknown>) {
    const res = await applyOp({ store: this.env.store, me: this.me, dm, peer, from: this.me }, { k: 'op', op: `local:${crypto.randomUUID()}`, kind, dm, data });
    if (res.status !== 'applied') throw new Error(res.status === 'rejected' ? 'Операция недоступна' : 'Нечего менять');
    this.env.onMessage(toMessage(res.message), false);
    await this.enqueue(dm, peer, kind, data);
  }

  async localMessages(dm: string): Promise<Message[]> {
    return (await this.env.store.messagesFor(this.me, dm)).map(toMessage);
  }

  async pendingCount(): Promise<number> {
    return (await this.env.store.outbox(this.me)).length;
  }

  // ---------- состояние для интерфейса ----------
  private publishLinks() {
    if (!this.env.onLinks) return;
    const out: Record<string, LinkInfo> = {};
    for (const r of this.rooms.values()) {
      for (const e of r.links.values()) {
        out[`msg:${e.key}`] = {
          peer: e.user,
          purpose: 'messages',
          state: e.state === 'secure' ? 'connected' : e.state === 'connecting' ? 'connecting' : e.state,
          path: e.state === 'secure' ? 'p2p' : 'unknown',
          encrypted: e.state === 'secure' ? 'X25519 + ML-KEM-768 → AES-256-GCM' : null,
        };
      }
    }
    this.env.onLinks(out);
  }

  /** Обновить сведения о пути (ICE-кандидаты, RTT) — по запросу экрана статистики */
  async refreshLinkInfo(): Promise<Record<string, LinkInfo>> {
    const out: Record<string, LinkInfo> = {};
    for (const r of this.rooms.values()) {
      for (const e of r.links.values()) {
        const snap = e.state === 'secure' ? await e.link.snapshot() : null;
        out[`msg:${e.key}`] = {
          peer: e.user,
          purpose: 'messages',
          state: e.state === 'secure' ? 'connected' : e.state === 'connecting' ? 'connecting' : e.state,
          path: snap ? snap.kind : 'unknown',
          candidates: snap?.local && snap.remote ? `${snap.local} ↔ ${snap.remote}` : null,
          rttMs: snap?.rttMs ?? null,
          encrypted: e.state === 'secure' ? 'X25519 + ML-KEM-768 → AES-256-GCM' : null,
        };
      }
    }
    this.env.onLinks?.(out);
    return out;
  }

  /** Список доверия изменился: разорвать соединения с устройствами, которым доверие отозвано */
  enforceTrust(allowed: (userId: string, pub: PublicIdentity) => boolean) {
    for (const r of this.rooms.values()) {
      for (const e of r.links.values()) {
        const pub = e.link.peerIdentity;
        if (pub && !allowed(e.user, pub)) {
          this.log(`hub: trust revoked, closing ${e.key}`);
          e.link.close(true);
        }
      }
    }
  }

  /** Сеть вернулась — пересоздать каналы presence и разорванные соединения без ожидания */
  onConnectivityRestored() {
    for (const r of this.rooms.values()) {
      r.ch.reconnectNow();
      for (const [key, rt] of r.retry) r.retry.set(key, { ...rt, at: 0 });
    }
  }

  async stop() {
    this.stopped = true;
    if (this.retryTimer) clearInterval(this.retryTimer);
    for (const r of [...this.rooms.values()]) this.closeRoom(r);
    for (const w of this.waiters.values()) w(false);
    this.waiters.clear();
    await this.env.store.flush();
  }
}
