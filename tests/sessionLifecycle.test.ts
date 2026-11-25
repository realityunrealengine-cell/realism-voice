import { afterEach, expect, it, vi } from 'vitest';
import { bootstrap, startRealtime, teardown } from '@/lib/realtime';
import { useAuth } from '@/stores/auth';
import { useSocial } from '@/stores/social';
import { useServers } from '@/stores/servers';
import { useUnread } from '@/stores/unread';
import type { Profile } from '@/lib/types';

const { from, rpc, channel, removeChannel, start } = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), channel: vi.fn(), removeChannel: vi.fn(), start: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({ supabase: { from, rpc, channel, removeChannel } }));
vi.mock('@/stores/presence', () => ({ usePresence: { getState: () => ({ start, stop: vi.fn() }) } }));
vi.mock('@/stores/voice', () => ({ useVoice: { getState: () => ({ leave: vi.fn() }) } }));

function login(id: string) {
  useAuth.setState({ status: 'signedIn', userId: id, profile: { id, status: 'online' } as Profile });
}

afterEach(() => {
  teardown();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('discards bootstrap results from A after logout and a completed login as B', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  function query(table: string) {
    const id = useAuth.getState().userId!;
    const rows: Record<string, unknown[]> = {
      servers: [{ id }], blocks: [{ blocked_id: id }],
      get_unread_counts: [{ scope_id: id, unread: 1, mentions: 0, server_id: null }],
    };
    const result = (id === 'A' ? delayed : Promise.resolve()).then(() => ({ data: rows[table] ?? [] }));
    const builder = {
      select: () => builder, order: () => builder, eq: () => builder, limit: () => builder,
      then: result.then.bind(result),
    };
    return builder;
  }
  from.mockImplementation(query);
  rpc.mockImplementation(query);
  const dbChannel = { on: () => dbChannel, subscribe: () => dbChannel };
  channel.mockReturnValue(dbChannel);

  login('A');
  const first = bootstrap();
  useAuth.setState({ status: 'signedOut', userId: null, profile: null });
  teardown();
  login('B');
  await bootstrap();
  release();
  await first;

  expect.soft(useServers.getState().servers.map((s) => s.id)).toEqual(['B']);
  expect.soft(useSocial.getState().blocked).toEqual(['B']);
  expect.soft(Object.keys(useUnread.getState().counts)).toEqual(['B']);
  expect.soft(start.mock.calls).toEqual([['B', 'online']]);
  expect(channel).toHaveBeenCalledTimes(1);
});

it('ignores a late event and reconnect completion from the previous channel', async () => {
  vi.useFakeTimers();
  let finishRemoval!: () => void;
  removeChannel.mockReturnValue(new Promise<void>((resolve) => { finishRemoval = resolve; }));
  const dbChannel = { on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() };
  channel.mockReturnValue(dbChannel);
  login('A');
  startRealtime();
  const status = dbChannel.subscribe.mock.calls[0][0];
  const onBlock = dbChannel.on.mock.calls.find(([, filter]) => filter.table === 'blocks')![2];
  status('CHANNEL_ERROR');
  await vi.advanceTimersByTimeAsync(1000);
  expect(removeChannel).toHaveBeenCalledWith(dbChannel);

  useAuth.setState({ status: 'signedOut', userId: null, profile: null });
  teardown();
  login('B');
  onBlock({ eventType: 'INSERT', new: { blocker_id: 'B', blocked_id: 'stale' } });
  startRealtime();
  expect(channel.mock.calls[1][0]).not.toEqual(channel.mock.calls[0][0]);
  finishRemoval();
  await vi.advanceTimersByTimeAsync(0);
  expect(useSocial.getState().blocked).toEqual([]);
  expect(channel).toHaveBeenCalledTimes(2);
});
