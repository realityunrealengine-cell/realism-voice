// Честные статусы: что видят остальные и что видит сам пользователь (выбор, «Неактивен», «Невидимый», сон ПК).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRealtimeServer, FakeRtClient } from './helpers/fakeSfu';

const server = new FakeRealtimeServer();
const client = new FakeRtClient(server);
vi.mock('@/lib/supabase', () => ({ supabase: client }));

const { usePresence, displayStatus, visibleOnline } = await import('@/stores/presence');

const ME = '00000000-0000-4000-8000-0000000000aa';

/** Статус, который видят другие клиенты (как в presence:global) */
function seenByOthers(): string | null {
  const metas = server.state('presence:global')[ME] ?? [];
  return (metas.at(-1)?.status as string | undefined) ?? null;
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('честные статусы', () => {
  beforeEach(async () => {
    usePresence.getState().start(ME, 'online');
    await flush();
  });
  afterEach(async () => {
    await usePresence.getState().stop();
  });

  it('«В сети»: видят все, сам пользователь видит себя «В сети» сразу, не дожидаясь сервера', async () => {
    expect(seenByOthers()).toBe('online');
    expect(displayStatus(usePresence.getState(), ME)).toBe('online');
  });

  it('отошёл (бездействие или блокировка) — «Неактивен», вернулся — снова «В сети»', async () => {
    usePresence.getState().setAway(true);
    await flush();
    expect(seenByOthers()).toBe('idle');
    expect(usePresence.getState().self).toBe('idle');
    usePresence.getState().setAway(false);
    await flush();
    expect(seenByOthers()).toBe('online');
  });

  it('«Не беспокоить» не меняется на «Неактивен» при отсутствии', async () => {
    usePresence.getState().setStatus('dnd');
    usePresence.getState().setAway(true);
    await flush();
    expect(seenByOthers()).toBe('dnd');
    expect(usePresence.getState().self).toBe('dnd');
  });

  it('«Невидимый»: остальные не видят, сам пользователь видит «Невидимый», а не «Не в сети»', async () => {
    usePresence.getState().setStatus('invisible');
    await flush();
    expect(seenByOthers()).toBeNull();
    const s = usePresence.getState();
    expect(displayStatus(s, ME)).toBe('invisible');
    expect(visibleOnline(s, ME)).toBe(false);
  });

  it('сон ПК: сразу пропадает из «В сети», после пробуждения возвращается', async () => {
    usePresence.getState().setAsleep(true);
    await flush();
    expect(seenByOthers()).toBeNull();
    usePresence.getState().setAsleep(false);
    await flush();
    expect(seenByOthers()).toBe('online');
  });

  it('статусы других — только по данным сервера', async () => {
    const other = '00000000-0000-4000-8000-0000000000bb';
    const s = usePresence.getState();
    expect(displayStatus(s, other)).toBe('offline');
    expect(visibleOnline(s, other)).toBe(false);
  });
});
