// Надёжный presence-канал Supabase Realtime.
//
// Что было не так. realtime-js сам переподключает канал только в состоянии «errored». Если сервер
// ЗАКРЫЛ канал (истёк JWT приватного канала, сон Windows, обрыв во время входа), канал удаляется
// из сокета и больше никогда не подключается, а приложение продолжает держать мёртвый объект:
// клиент считает себя «в сети», другие его не видят, список голосовых участников замирает.
// Кроме того, supabase.channel(topic) возвращает СУЩЕСТВУЮЩИЙ канал с той же темой: если открыть
// канал заново, пока старый ещё закрывается, получится мёртвый канал.
//
// SupervisedChannel:
//   * пересоздаёт канал после CLOSED / CHANNEL_ERROR / TIMED_OUT с нарастающей паузой;
//   * после каждого (пере)подключения снова отправляет своё присутствие (track);
//   * check() без сетевых запросов сверяет, есть ли наша запись в состоянии presence, и
//     восстанавливает её, если сервер её потерял (вызывается по таймеру и после сна/сети);
//   * не создаёт новый канал, пока старый не удалён.

export type SubscribeStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

export interface RtChannel {
  on(type: 'presence', filter: { event: 'sync' }, cb: () => void): RtChannel;
  subscribe(cb: (status: SubscribeStatus, err?: Error) => void): RtChannel;
  track(payload: Record<string, unknown>): Promise<unknown>;
  untrack(): Promise<unknown>;
  presenceState(): Record<string, Record<string, unknown>[]>;
}

export interface RtClient {
  channel(topic: string, opts: { config: { private: boolean; presence: { key: string } } }): RtChannel;
  removeChannel(ch: RtChannel): Promise<unknown>;
}

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];
/** Сколько ждать подписки, прежде чем пересоздать канал */
export const JOIN_DEADLINE_MS = 15000;

export interface SupervisedOptions {
  client: RtClient;
  topic: string;
  key: string;
  /** Идентификатор этого экземпляра приложения: отличает наши записи от записей других устройств */
  session: string;
  onSync: (state: Record<string, Record<string, unknown>[]>) => void;
  onJoinedChange?: (joined: boolean) => void;
  timers?: Timers;
  log?: (msg: string) => void;
}

export class SupervisedChannel {
  private ch: RtChannel | null = null;
  private joined = false;
  private stopped = false;
  private payload: Record<string, unknown> | null = null;
  private attempt = 0;
  private retryTimer: unknown = null;
  private lastJoinAttempt = 0;
  private generation = 0;
  private recreating: Promise<void> | null = null;
  private readonly t: Timers;

  constructor(private readonly o: SupervisedOptions) {
    this.t = o.timers ?? realTimers;
  }

  get isJoined(): boolean {
    return this.joined;
  }

  get topic(): string {
    return this.o.topic;
  }

  start(): void {
    if (this.stopped || this.ch) return;
    this.open();
  }

  /** Что сообщать о себе; null — не показываться (невидимка / не в голосе) */
  setPayload(payload: Record<string, unknown> | null): void {
    this.payload = payload ? { ...payload, session: this.o.session } : null;
    if (this.joined) void this.push();
  }

  /** Сверка без сетевых запросов; при расхождении — восстановление */
  check(): void {
    if (this.stopped) return;
    if (!this.ch) {
      this.open();
      return;
    }
    if (!this.joined) {
      if (this.t.now() - this.lastJoinAttempt > JOIN_DEADLINE_MS) this.recreate('join deadline');
      return;
    }
    const mine = this.ownMetas();
    if (this.payload && mine.length === 0) {
      this.o.log?.(`${this.o.topic}: own presence missing, re-tracking`);
      void this.push();
    } else if (!this.payload && mine.length > 0) {
      void this.push();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRetry();
    const ch = this.ch;
    this.ch = null;
    this.setJoined(false);
    if (ch) {
      if (this.payload) await ch.untrack().catch(() => undefined);
      await this.o.client.removeChannel(ch).catch(() => undefined);
    }
  }

  /** Немедленно пересоздать канал (например, после выхода из сна) */
  reconnectNow(): void {
    if (this.stopped) return;
    this.attempt = 0;
    this.recreate('forced');
  }

  private ownMetas(): Record<string, unknown>[] {
    const state = this.ch?.presenceState() ?? {};
    return (state[this.o.key] ?? []).filter((m) => m && m.session === this.o.session);
  }

  private setJoined(v: boolean) {
    if (this.joined === v) return;
    this.joined = v;
    this.o.onJoinedChange?.(v);
  }

  private open() {
    const gen = ++this.generation;
    this.lastJoinAttempt = this.t.now();
    const ch = this.o.client.channel(this.o.topic, { config: { private: true, presence: { key: this.o.key } } });
    this.ch = ch;
    ch.on('presence', { event: 'sync' }, () => {
      if (gen === this.generation) this.o.onSync(ch.presenceState());
    });
    ch.subscribe((status, err) => {
      if (gen !== this.generation || this.stopped) return;
      if (status === 'SUBSCRIBED') {
        this.attempt = 0;
        this.clearRetry();
        this.setJoined(true);
        void this.push();
        this.o.onSync(ch.presenceState());
        return;
      }
      this.setJoined(false);
      this.o.log?.(`${this.o.topic}: ${status}${err ? ` (${err.message})` : ''}`);
      // CLOSED: канал удалён из сокета и сам не вернётся. ERROR/TIMEOUT: phoenix может
      // переподключиться сам, но если этого не произойдёт, канал пересоздаст check() или таймер.
      this.scheduleRecreate();
    });
  }

  private async push(): Promise<void> {
    const ch = this.ch;
    if (!ch || !this.joined) return;
    const res = this.payload ? await ch.track(this.payload).catch(() => 'error') : await ch.untrack().catch(() => 'error');
    if (res !== 'ok' && ch === this.ch && !this.stopped) {
      this.o.log?.(`${this.o.topic}: ${this.payload ? 'track' : 'untrack'} -> ${String(res)}`);
      this.scheduleRecreate();
    }
  }

  private scheduleRecreate() {
    if (this.retryTimer || this.stopped) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.retryTimer = this.t.setTimeout(() => {
      this.retryTimer = null;
      if (!this.joined) this.recreate('retry');
    }, delay);
  }

  private clearRetry() {
    if (this.retryTimer) this.t.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private recreate(reason: string) {
    if (this.stopped || this.recreating) return;
    this.o.log?.(`${this.o.topic}: recreate (${reason})`);
    this.clearRetry();
    const old = this.ch;
    this.ch = null;
    this.generation++;
    this.setJoined(false);
    this.recreating = (async () => {
      // Старый канал обязательно удаляется ДО создания нового: иначе client.channel(topic)
      // вернёт тот же закрывающийся объект.
      if (old) await this.o.client.removeChannel(old).catch(() => undefined);
      this.recreating = null;
      if (!this.stopped) this.open();
    })();
  }
}
