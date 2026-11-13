// Один голосовой сеанс через Cloudflare Realtime SFU: комната, публикация, подписки, восстановление.
//
//   start():  Edge Function voice-sfu (права + сессии SFU) → presence комнаты (кто в комнате и какие
//             треки публикует) → публикация своих треков → подписка на треки остальных.
//   Сбой медиасоединения (ICE failed / disconnected дольше 5 с): по официальной рекомендации
//   Cloudflare создаётся НОВАЯ сессия SFU, треки публикуются заново, подписки восстанавливаются.
//   Участник при этом остаётся в комнате (присутствие сохраняется), у остальных нет «мигания».
//   Паузы между попытками и ожидание сети — reconnectPolicy; через минуту без успеха — «Соединение потеряно».
//   close():  снятие присутствия, закрытие RTCPeerConnection и треков в SFU.
import { SupervisedChannel, type RtClient } from '@/lib/presenceChannel';
import { nextReconnect } from '@/lib/reconnectPolicy';
import type { JoinResult, JoinTarget, SessionGrant, VoiceApi } from './api';
import { ClosedError, defaultPcFactory, Publisher, rtcConfig, Subscriber, type PcFactory, type PublishItem } from './peer';
import { desiredTracks, reduceRoom, roomTopic, type Quality, type RoomMember, type RoomPresencePayload, type Source } from './protocol';
import { countersFromStats, qualityFrom, worst, type LinkCounters } from './quality';

export interface CallEvents {
  roster(others: RoomMember[]): void;
  track(userId: string, source: Source, track: MediaStreamTrack | null): void;
  status(status: 'connected' | 'reconnecting', attempt: number): void;
  lost(): void;
  superseded(): void;
  speaking(userIds: Set<string>): void;
  quality(q: Quality): void;
}

export interface CallDeps {
  api: VoiceApi;
  rt: RtClient;
  pcFactory?: PcFactory;
  online?: () => boolean;
  onOnline?: (fn: () => void) => () => void;
  log?: (msg: string) => void;
}

export class RoomFullError extends Error {
  constructor() {
    super('Канал заполнен');
    this.name = 'RoomFullError';
  }
}

export const JOIN_TIMEOUT_MS = 12_000;
export const MEDIA_TIMEOUT_MS = 15_000;
export const DISCONNECTED_GRACE_MS = 5_000;
const SPEAKING_POLL_MS = 200;
const SPEAKING_LEVEL = 0.01;
const SPEAKING_HOLD_MS = 400;
const STATS_MS = 3_000;
const WATCHDOG_MS = 20_000;

type Scope = 'pub' | 'sub';
export type LocalSources = Partial<Record<Source, Omit<PublishItem, 'source'>>>;

function waitConnected(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.connectionState === 'connected') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      clearTimeout(t);
      pc.removeEventListener('connectionstatechange', on);
      err ? reject(err) : resolve();
    };
    const on = () => {
      if (pc.connectionState === 'connected') done();
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') done(new Error('media_failed'));
    };
    const t = setTimeout(() => done(new Error('media_timeout')), ms);
    pc.addEventListener('connectionstatechange', on);
  });
}

export class SfuCall {
  canSpeak = false;
  userLimit: number | null = null;
  others: RoomMember[] = [];
  readonly joinedAt = Date.now();

  private pub: Publisher | null = null;
  private sub: Subscriber | null = null;
  private config: RTCConfiguration = rtcConfig(null);
  private readonly local = new Map<Source, Omit<PublishItem, 'source'>>();
  private flags = { muted: false, deafened: false };
  private q: Quality = 'unknown';
  private channel: SupervisedChannel | null = null;
  private closed = false;
  private synced = false;
  private syncWaiters: (() => void)[] = [];
  private supersededSent = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private discTimers = new Map<RTCPeerConnection, ReturnType<typeof setTimeout>>();
  private pending = new Set<Scope>();
  private recovering = false;
  private recoverTimer: ReturnType<typeof setTimeout> | null = null;
  private offOnline: (() => void) | null = null;
  private speakingNow = new Set<string>();
  private loudAt = new Map<string, number>();
  private counters = new Map<RTCPeerConnection, LinkCounters>();
  private readonly pcFactory: PcFactory;

  constructor(
    readonly target: JoinTarget,
    private readonly userId: string,
    private readonly session: string,
    private readonly ev: CallEvents,
    private readonly deps: CallDeps,
  ) {
    this.pcFactory = deps.pcFactory ?? defaultPcFactory;
  }

  private online(): boolean {
    return this.deps.online ? this.deps.online() : typeof navigator === 'undefined' || navigator.onLine !== false;
  }

  // ---------- вход ----------
  /**
   * @param provide захват своих источников после проверки прав (идёт параллельно с входом в комнату):
   *                слушателю микрофон не нужен, поэтому он запрашивается только если можно говорить
   */
  async start(provide?: (canSpeak: boolean) => Promise<LocalSources>): Promise<void> {
    const res = await this.deps.api.join(this.target, 'all');
    this.assertOpen();
    this.applyJoin(res);
    this.config = rtcConfig(res.ice_servers);
    if (res.pub) this.pub = this.makePublisher(res.pub);
    if (res.sub) this.sub = this.makeSubscriber(res.sub);
    const localP: Promise<LocalSources> = provide ? provide(this.canSpeak).catch(() => ({})) : Promise.resolve({});

    // Присутствие в комнате: кто здесь и какие треки публикует
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Не удалось подключиться к комнате (Supabase Realtime не ответил)')), JOIN_TIMEOUT_MS);
      this.channel = new SupervisedChannel({
        client: this.deps.rt,
        topic: roomTopic(this.target),
        key: this.userId,
        session: this.session,
        log: this.deps.log,
        onSync: (state) => this.onSync(state),
        onJoinedChange: (joined) => {
          if (joined) {
            clearTimeout(t);
            resolve();
          }
        },
      });
      this.channel.start();
    });
    this.assertOpen();
    await this.waitFirstSync(1500);
    this.assertOpen();
    if (this.userLimit && this.others.length >= this.userLimit) throw new RoomFullError();
    this.pushPresence();
    const initial = await localP;
    this.assertOpen();
    for (const [k, v] of Object.entries(initial) as [Source, Omit<PublishItem, 'source'>][]) if (v) this.local.set(k, v);

    if (this.pub && this.canSpeak && this.local.size) {
      await this.pub.publish(this.items());
      this.assertOpen();
      this.pushPresence();
      await waitConnected(this.pub.pc, MEDIA_TIMEOUT_MS).catch(() => {
        throw new Error('Не удалось установить медиасоединение с Cloudflare Realtime. Возможно, сеть блокирует UDP.');
      });
    }
    this.assertOpen();
    this.timers.push(setInterval(() => this.pollSpeaking(), SPEAKING_POLL_MS));
    this.timers.push(setInterval(() => void this.pollStats(), STATS_MS));
    this.timers.push(setInterval(() => this.channel?.check(), WATCHDOG_MS));
  }

  private assertOpen() {
    if (this.closed) throw new ClosedError();
  }

  private applyJoin(res: JoinResult) {
    this.canSpeak = !!res.can_speak;
    this.userLimit = res.user_limit ?? null;
  }

  private waitFirstSync(ms: number): Promise<void> {
    if (this.synced) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.syncWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private items(): PublishItem[] {
    return [...this.local.entries()].map(([source, v]) => ({ source, ...v }));
  }

  private payload(): RoomPresencePayload {
    return {
      user_id: this.userId,
      joined_at: this.joinedAt,
      at: Date.now(),
      pub: this.pub && this.canSpeak ? this.pub.sessionId : null,
      tracks: this.pub && this.canSpeak ? this.pub.tracks() : [],
      muted: this.flags.muted || !this.canSpeak,
      deafened: this.flags.deafened,
      quality: this.q,
    };
  }

  private pushPresence() {
    if (!this.closed) this.channel?.setPayload(this.payload() as unknown as Record<string, unknown>);
  }

  private onSync(state: Record<string, Record<string, unknown>[]>) {
    if (this.closed) return;
    const view = reduceRoom(state, { userId: this.userId, session: this.session, joinedAt: this.joinedAt });
    if (view.superseded && !this.supersededSent) {
      this.supersededSent = true;
      this.ev.superseded();
      return;
    }
    this.others = view.others;
    // Первая «настоящая» синхронизация — когда сервер прислал состояние (в нём есть мы или кто-то ещё)
    if (!this.synced && Object.keys(state).length > 0) {
      this.synced = true;
      for (const w of this.syncWaiters.splice(0)) w();
    }
    this.ev.roster(this.others);
    for (const id of [...this.loudAt.keys()]) if (!this.others.some((o) => o.userId === id)) this.loudAt.delete(id);
    this.sub?.setDesired(desiredTracks(this.others));
  }

  // ---------- соединения ----------
  private watchPc(pc: RTCPeerConnection, scope: Scope) {
    pc.addEventListener('connectionstatechange', () => {
      if (this.closed) return;
      const cur = scope === 'pub' ? this.pub?.pc : this.sub?.pc;
      if (cur !== pc) return;
      const st = pc.connectionState;
      const timer = this.discTimers.get(pc);
      if (st === 'failed') {
        this.recover(scope);
      } else if (st === 'disconnected') {
        if (!timer) {
          this.discTimers.set(
            pc,
            setTimeout(() => {
              this.discTimers.delete(pc);
              if (pc.connectionState !== 'connected' && !this.closed) this.recover(scope);
            }, DISCONNECTED_GRACE_MS),
          );
        }
      } else if (timer) {
        clearTimeout(timer);
        this.discTimers.delete(pc);
      }
    });
  }

  private makePublisher(grant: SessionGrant): Publisher {
    const p = new Publisher(this.deps.api, grant, this.config, this.pcFactory);
    this.watchPc(p.pc, 'pub');
    return p;
  }

  private makeSubscriber(grant: SessionGrant): Subscriber {
    const s = new Subscriber(this.deps.api, grant, this.config, this.pcFactory, {
      onTrack: (ref, track) => {
        if (this.sub === s && !this.closed) this.ev.track(ref.userId, ref.source, track);
      },
      onTrackGone: (ref) => {
        if (!this.closed) this.ev.track(ref.userId, ref.source, null);
      },
      onError: (e) => {
        if (this.sub !== s || this.closed) return;
        this.deps.log?.(`subscribe failed: ${(e as Error)?.message}`);
        this.recover('sub');
      },
    });
    s.onPcCreated = (pc) => this.watchPc(pc, 'sub');
    return s;
  }

  /** Восстановление медиасоединения новой сессией SFU */
  recover(scope: Scope) {
    if (this.closed) return;
    this.pending.add(scope);
    if (this.recovering) return;
    this.recovering = true;
    const startedAt = Date.now();
    let attempt = 0;
    this.ev.status('reconnecting', 0);

    const step = () => {
      if (this.closed) return;
      const d = nextReconnect(attempt, startedAt, Date.now(), this.online());
      if (d.action === 'give-up') {
        this.recovering = false;
        this.ev.lost();
        return;
      }
      if (d.action === 'wait-network') {
        const off = (this.deps.onOnline ?? defaultOnOnline)(() => {
          off();
          if (this.recoverTimer) clearTimeout(this.recoverTimer);
          this.recoverTimer = null;
          this.offOnline = null;
          step();
        });
        this.offOnline = off;
        this.recoverTimer = setTimeout(() => {
          off();
          this.offOnline = null;
          this.recoverTimer = null;
          step();
        }, d.delayMs);
        return;
      }
      this.recoverTimer = setTimeout(() => {
        this.recoverTimer = null;
        attempt++;
        this.ev.status('reconnecting', attempt);
        void this.rebuild()
          .then(() => {
            if (this.closed) return;
            if (this.pending.size) {
              step();
              return;
            }
            this.recovering = false;
            this.ev.status('connected', 0);
          })
          .catch((e) => {
            if (this.closed || e instanceof ClosedError) return;
            this.deps.log?.(`recover attempt ${attempt} failed: ${(e as Error)?.message}`);
            step();
          });
      }, d.delayMs);
    };
    step();
  }

  private async rebuild(): Promise<void> {
    const scopes = new Set(this.pending);
    this.pending.clear();
    const scope = scopes.has('pub') && scopes.has('sub') ? 'all' : scopes.has('pub') ? 'pub' : 'sub';
    let res: JoinResult;
    try {
      res = await this.deps.api.join(this.target, scope);
    } catch (e) {
      for (const s of scopes) this.pending.add(s);
      throw e;
    }
    this.assertOpen();
    this.applyJoin(res);
    if (scopes.has('sub')) {
      const old = this.sub;
      const mids = old?.close() ?? [];
      if (old && mids.length) void this.deps.api.close(null, { session: old.session, mids }).catch(() => undefined);
      this.sub = res.sub ? this.makeSubscriber(res.sub) : null;
      this.sub?.setDesired(desiredTracks(this.others));
    }
    if (scopes.has('pub')) {
      const old = this.pub;
      const mids = old?.close() ?? [];
      if (old && mids.length) void this.deps.api.close({ session: old.session, mids }, null).catch(() => undefined);
      this.pub = res.pub ? this.makePublisher(res.pub) : null;
      this.pushPresence();
      if (this.pub && this.canSpeak && this.local.size) {
        try {
          await this.pub.publish(this.items());
          this.pushPresence();
          await waitConnected(this.pub.pc, MEDIA_TIMEOUT_MS);
        } catch (e) {
          this.pending.add('pub');
          throw e;
        }
      }
    }
    this.pushPresence();
  }

  // ---------- свои треки ----------
  /** Включить, заменить или убрать свои источники (null — убрать) */
  async setSources(changes: Partial<Record<Source, Omit<PublishItem, 'source'> | null>>): Promise<void> {
    const add: PublishItem[] = [];
    const remove: Source[] = [];
    const replace: [Source, MediaStreamTrack][] = [];
    for (const [k, v] of Object.entries(changes) as [Source, Omit<PublishItem, 'source'> | null][]) {
      const had = this.local.has(k);
      if (v) {
        this.local.set(k, v);
        if (this.pub?.has(k)) replace.push([k, v.track]);
        else add.push({ source: k, ...v });
      } else {
        this.local.delete(k);
        if (had) remove.push(k);
      }
    }
    const pub = this.pub;
    if (!pub || !this.canSpeak || this.closed) return;
    try {
      for (const [s, t] of replace) await pub.replace(s, t);
      if (remove.length) await pub.unpublish(remove);
      if (add.length) await pub.publish(add);
      this.pushPresence();
    } catch (e) {
      if (e instanceof ClosedError || this.closed || pub !== this.pub) return;
      this.deps.log?.(`publish failed: ${(e as Error)?.message}`);
      // Сессия публикации в неизвестном состоянии — заменяем её, треки опубликуются заново
      this.recover('pub');
      throw e;
    }
  }

  hasSource(s: Source): boolean {
    return this.local.has(s);
  }

  setFlags(flags: { muted: boolean; deafened: boolean }) {
    if (flags.muted === this.flags.muted && flags.deafened === this.flags.deafened) return;
    this.flags = { ...flags };
    this.pushPresence();
  }

  get quality(): Quality {
    return this.q;
  }

  // ---------- индикаторы ----------
  private pollSpeaking() {
    if (!this.sub) return;
    const now = Date.now();
    for (const { ref, receiver } of this.sub.receivers()) {
      if (ref.source !== 'mic') continue;
      let level = 0;
      try {
        for (const s of receiver.getSynchronizationSources()) level = Math.max(level, s.audioLevel ?? 0);
      } catch {
        /* ignore */
      }
      if (level > SPEAKING_LEVEL) this.loudAt.set(ref.userId, now);
    }
    const next = new Set<string>();
    for (const [id, at] of this.loudAt) if (now - at < SPEAKING_HOLD_MS) next.add(id);
    if (next.size !== this.speakingNow.size || [...next].some((id) => !this.speakingNow.has(id))) {
      this.speakingNow = next;
      this.ev.speaking(next);
    }
  }

  private async pollStats() {
    const pcs = [this.pub?.pc, this.sub?.pc].filter((p): p is RTCPeerConnection => !!p);
    const list: Quality[] = [];
    for (const pc of pcs) {
      try {
        const report = await pc.getStats();
        const cur = countersFromStats([...report.values()] as Record<string, unknown>[]);
        list.push(qualityFrom(this.counters.get(pc) ?? null, cur, pc.connectionState === 'connected'));
        this.counters.set(pc, cur);
      } catch {
        /* соединение закрыто */
      }
    }
    if (this.closed) return;
    const q = list.length ? worst(list) : 'unknown';
    if (q !== this.q) {
      this.q = q;
      this.ev.quality(q);
      this.pushPresence();
    }
  }

  /** Сеть или система вернулись: проверить комнату немедленно */
  onConnectivityRestored() {
    if (this.closed) return;
    this.channel?.reconnectNow();
    for (const [scope, pc] of [['pub', this.pub?.pc], ['sub', this.sub?.pc]] as const) {
      if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) this.recover(scope);
    }
  }

  // ---------- выход ----------
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const t of this.discTimers.values()) clearTimeout(t);
    this.discTimers.clear();
    if (this.recoverTimer) clearTimeout(this.recoverTimer);
    this.offOnline?.();
    for (const w of this.syncWaiters.splice(0)) w();
    const pub = this.pub;
    const sub = this.sub;
    const pubMids = pub?.close() ?? [];
    const subMids = sub?.close() ?? [];
    this.pub = this.sub = null;
    const ch = this.channel;
    this.channel = null;
    await Promise.all([
      ch?.stop(),
      this.deps.api
        .close(pub && pubMids.length ? { session: pub.session, mids: pubMids } : null, sub && subMids.length ? { session: sub.session, mids: subMids } : null)
        .catch(() => undefined),
    ]);
  }
}

function defaultOnOnline(fn: () => void): () => void {
  window.addEventListener('online', fn);
  return () => window.removeEventListener('online', fn);
}
