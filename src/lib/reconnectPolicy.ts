// Политика восстановления голосового соединения после обрыва (чистая логика, покрыта тестами).
//
// Если медиасоединение с Cloudflare Realtime SFU оборвалось (ICE failed или disconnected дольше 5 с),
// приложение создаёт новую сессию SFU и публикует треки заново (src/lib/sfu/call.ts):
//   * паузы растут: 1, 2, 4, 8, 15 с;
//   * пока Windows сообщает, что сети нет, попытки не тратятся — ждём восстановления сети;
//   * через RECONNECT_DEADLINE_MS после обрыва попытки прекращаются: состояние «Соединение потеряно»,
//     пользователь убирается из списка участников и может нажать «Переподключиться».

export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
export const RECONNECT_DEADLINE_MS = 60_000;

export interface ReconnectDecision {
  action: 'wait-network' | 'retry' | 'give-up';
  delayMs: number;
}

export function nextReconnect(attempt: number, startedAt: number, now: number, online: boolean): ReconnectDecision {
  const elapsed = now - startedAt;
  if (elapsed >= RECONNECT_DEADLINE_MS) return { action: 'give-up', delayMs: 0 };
  const left = RECONNECT_DEADLINE_MS - elapsed;
  if (!online) return { action: 'wait-network', delayMs: left };
  const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
  if (delay >= left) return { action: 'give-up', delayMs: 0 };
  return { action: 'retry', delayMs: delay };
}

/**
 * Поколение подключения. Каждое новое подключение или выход увеличивает номер;
 * асинхронный код старого подключения проверяет номер после каждого await и, если он устарел,
 * разрывает свою комнату вместо того, чтобы оставить «призрака» в чужом канале.
 */
export class ConnectionGeneration {
  private n = 0;
  next(): number {
    return ++this.n;
  }
  invalidate(): void {
    this.n++;
  }
  isCurrent(g: number): boolean {
    return g === this.n;
  }
}

export class StaleConnectionError extends Error {
  constructor() {
    super('stale voice connection');
    this.name = 'StaleConnectionError';
  }
}
