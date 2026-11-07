// Три клиента в одном голосовом канале на поддельном сервере Realtime.
// Сервер ведёт себя как Supabase Realtime: присутствие привязано к подключению, при закрытии канала
// сервером клиент получает CLOSED и канал удаляется из сокета; supabase.channel(topic) возвращает
// уже существующий канал с той же темой.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupervisedChannel, type RtChannel, type RtClient, type SubscribeStatus } from '@/lib/presenceChannel';
import { reduceVoicePresence, type VoicePresenceMeta } from '@/lib/voiceRoster';

type Meta = Record<string, unknown>;

class FakeServer {
  channels = new Set<FakeChannel>();
  join(ch: FakeChannel) {
    this.channels.add(ch);
    this.broadcast(ch.topic);
  }
  leave(ch: FakeChannel) {
    this.channels.delete(ch);
    this.broadcast(ch.topic);
  }
  state(topic: string): Record<string, Meta[]> {
    const out: Record<string, Meta[]> = {};
    for (const ch of this.channels) {
      if (ch.topic !== topic || !ch.tracked) continue;
      (out[ch.key] ??= []).push(ch.tracked);
    }
    return out;
  }
  broadcast(topic: string) {
    for (const ch of this.channels) if (ch.topic === topic) ch.receiveSync(this.state(topic));
  }
  /** Сервер забыл присутствие клиента, не закрывая канал (перезапуск узла, потерянный heartbeat) */
  forget(ch: FakeChannel) {
    ch.tracked = null;
    this.broadcast(ch.topic);
  }
}

class FakeChannel implements RtChannel {
  status: 'closed' | 'joining' | 'joined' | 'leaving' = 'closed';
  tracked: Meta | null = null;
  private syncCb: (() => void) | null = null;
  private statusCb: ((s: SubscribeStatus, e?: Error) => void) | null = null;
  private lastState: Record<string, Meta[]> = {};
  constructor(public client: FakeClient, public topic: string, public key: string) {}
  on(_t: 'presence', _f: { event: 'sync' }, cb: () => void) {
    this.syncCb = cb;
    return this;
  }
  subscribe(cb: (s: SubscribeStatus, e?: Error) => void) {
    if (this.status !== 'closed') return this; // как в realtime-js: повторная подписка ничего не делает
    this.statusCb = cb;
    this.status = 'joining';
    queueMicrotask(() => {
      if (this.status !== 'joining') return;
      if (!this.client.online) {
        this.status = 'closed';
        this.client.channels.delete(this.topic);
        cb('CHANNEL_ERROR', new Error('offline'));
        return;
      }
      this.status = 'joined';
      this.client.server.join(this);
      cb('SUBSCRIBED');
    });
    return this;
  }
  async track(payload: Meta) {
    if (this.status !== 'joined' || !this.client.online) return 'error';
    this.tracked = payload;
    this.client.server.broadcast(this.topic);
    return 'ok';
  }
  async untrack() {
    if (this.status !== 'joined' || !this.client.online) return 'error';
    this.tracked = null;
    this.client.server.broadcast(this.topic);
    return 'ok';
  }
  presenceState() {
    return this.lastState;
  }
  receiveSync(state: Record<string, Meta[]>) {
    if (this.status !== 'joined' || !this.client.online) return;
    this.lastState = state;
    this.syncCb?.();
  }
  /** Сервер закрыл канал (истёк токен, обрыв): клиент получает CLOSED, канал удалён из сокета */
  serverClose() {
    this.status = 'closed';
    this.tracked = null;
    this.client.server.leave(this);
    this.client.channels.delete(this.topic);
    this.statusCb?.('CLOSED');
  }
}

class FakeClient implements RtClient {
  online = true;
  channels = new Map<string, FakeChannel>();
  constructor(public server: FakeServer, public key: string) {}
  channel(topic: string) {
    const existing = this.channels.get(topic);
    if (existing) return existing; // поведение supabase.channel()
    const ch = new FakeChannel(this, topic, this.key);
    this.channels.set(topic, ch);
    return ch;
  }
  async removeChannel(ch: RtChannel) {
    const c = ch as FakeChannel;
    c.status = 'leaving';
    await Promise.resolve();
    c.status = 'closed';
    c.tracked = null;
    this.server.leave(c);
    this.channels.delete(c.topic);
  }
  /** Потеря интернета: сервер выкидывает все каналы клиента */
  goOffline() {
    this.online = false;
    for (const ch of [...this.channels.values()]) ch.serverClose();
  }
}

const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const CH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOPIC = 'voice:server-1';

async function flush() {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}

describe('синхронизация состава голосового канала у трёх клиентов', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const server = new FakeServer();
    const clients = IDS.map((id) => new FakeClient(server, id));
    const views = IDS.map(() => [] as string[]);
    const supervisors = clients.map(
      (client, i) =>
        new SupervisedChannel({
          client,
          topic: TOPIC,
          key: IDS[i],
          session: `session-${i}`,
          onSync: (state) => {
            views[i] = reduceVoicePresence(state as Record<string, VoicePresenceMeta[]>).map((m) => m.user_id);
          },
        }),
    );
    supervisors.forEach((s, i) => {
      s.setPayload({ user_id: IDS[i], channel_id: CH, joined_at: i + 1, at: i + 1 });
      s.start();
    });
    return { server, clients, views, supervisors };
  }

  it('все трое видят одинаковый состав из трёх участников', async () => {
    const { views } = setup();
    await flush();
    for (const v of views) expect(v).toEqual(IDS);
  });

  it('воспроизведение старой ошибки: канал, закрытый сервером, без надзора не возвращается никогда', async () => {
    const server = new FakeServer();
    const others = IDS.slice(0, 2).map((id) => new FakeClient(server, id));
    const third = new FakeClient(server, IDS[2]);
    for (const [i, c] of [...others, third].entries()) {
      const ch = c.channel(TOPIC);
      ch.on('presence', { event: 'sync' }, () => undefined);
      // старая логика: track только в колбэке SUBSCRIBED
      ch.subscribe((s) => s === 'SUBSCRIBED' && void ch.track({ user_id: IDS[i], channel_id: CH }));
    }
    await flush();
    expect(Object.keys(server.state(TOPIC))).toHaveLength(3);
    third.goOffline();
    third.online = true; // интернет вернулся
    await vi.advanceTimersByTimeAsync(120_000);
    // Канал третьего удалён из сокета, а приложение держит мёртвый объект: у остальных «2», в LiveKit «3»
    expect(Object.keys(server.state(TOPIC))).toHaveLength(2);
  });

  it('обрыв интернета у одного клиента: остальные видят двоих, после восстановления — снова троих', async () => {
    const { clients, views, supervisors } = setup();
    await flush();
    clients[2].goOffline();
    await flush();
    expect(views[0]).toEqual(IDS.slice(0, 2));
    expect(views[1]).toEqual(IDS.slice(0, 2));
    expect(supervisors[2].isJoined).toBe(false);
    // Пока сети нет, попытки не проходят
    await vi.advanceTimersByTimeAsync(10_000);
    expect(views[0]).toEqual(IDS.slice(0, 2));
    clients[2].online = true;
    await vi.advanceTimersByTimeAsync(31_000);
    await flush();
    expect(supervisors[2].isJoined).toBe(true);
    for (const v of views) expect(v).toEqual(IDS);
  });

  it('сервер тихо потерял присутствие клиента — сверка по таймеру восстанавливает его без пересоздания канала', async () => {
    const { server, clients, views, supervisors } = setup();
    await flush();
    server.forget(clients[2].channels.get(TOPIC)!);
    expect(views[0]).toEqual(IDS.slice(0, 2));
    supervisors[2].check();
    await flush();
    for (const v of views) expect(v).toEqual(IDS);
  });

  it('канал закрыт сервером при живом интернете (истёк токен) — пересоздаётся и присутствие возвращается', async () => {
    const { clients, views } = setup();
    await flush();
    clients[1].channels.get(TOPIC)!.serverClose();
    await flush();
    expect(views[0]).toEqual([IDS[0], IDS[2]]);
    await vi.advanceTimersByTimeAsync(1_500);
    await flush();
    for (const v of views) expect(v).toEqual(IDS);
  });

  it('выход из голоса убирает участника у всех, повторный вход возвращает', async () => {
    const { views, supervisors } = setup();
    await flush();
    supervisors[0].setPayload(null);
    await flush();
    expect(views[1]).toEqual(IDS.slice(1));
    supervisors[0].setPayload({ user_id: IDS[0], channel_id: CH, joined_at: 9, at: 9 });
    await flush();
    expect(views[2]).toEqual([IDS[1], IDS[2], IDS[0]]);
  });

  it('остановка (выход из аккаунта) снимает присутствие', async () => {
    const { views, supervisors } = setup();
    await flush();
    await supervisors[2].stop();
    await flush();
    expect(views[0]).toEqual(IDS.slice(0, 2));
  });
});
