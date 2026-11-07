import { describe, expect, it } from 'vitest';
import { ConnectionGeneration, RECONNECT_DEADLINE_MS, nextReconnect } from '@/lib/reconnectPolicy';

describe('восстановление голосового соединения', () => {
  it('паузы растут, затем попытки прекращаются по сроку', () => {
    const t0 = 1_000_000;
    expect(nextReconnect(0, t0, t0, true)).toEqual({ action: 'retry', delayMs: 1000 });
    expect(nextReconnect(1, t0, t0 + 1000, true)).toEqual({ action: 'retry', delayMs: 2000 });
    expect(nextReconnect(4, t0, t0 + 20_000, true)).toEqual({ action: 'retry', delayMs: 15000 });
    expect(nextReconnect(9, t0, t0 + 20_000, true).delayMs).toBe(15000);
    expect(nextReconnect(0, t0, t0 + RECONNECT_DEADLINE_MS, true).action).toBe('give-up');
  });

  it('без сети попытки не тратятся — ожидание до восстановления или до срока', () => {
    const t0 = 0;
    const d = nextReconnect(3, t0, 10_000, false);
    expect(d.action).toBe('wait-network');
    expect(d.delayMs).toBe(RECONNECT_DEADLINE_MS - 10_000);
  });

  it('не планирует попытку, которая закончится после срока', () => {
    expect(nextReconnect(4, 0, RECONNECT_DEADLINE_MS - 5_000, true).action).toBe('give-up');
  });

  it('поколение: подключение, начатое до выхода, считается устаревшим', () => {
    const g = new ConnectionGeneration();
    const first = g.next();
    expect(g.isCurrent(first)).toBe(true);
    g.invalidate(); // пользователь нажал «Отключиться» во время подключения
    expect(g.isCurrent(first)).toBe(false);
    const second = g.next();
    expect(g.isCurrent(second)).toBe(true);
    expect(g.isCurrent(first)).toBe(false);
  });
});
