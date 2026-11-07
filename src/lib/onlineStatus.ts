import type { PresenceStatus } from './types';
import { isUserId } from './voiceRoster';

export type OnlineStatus = Exclude<PresenceStatus, 'invisible'>;

const VISIBLE: ReadonlySet<string> = new Set(['online', 'idle', 'dnd']);

/**
 * Онлайн-статусы из presence:global. У пользователя может быть несколько устройств
 * (несколько записей под одним ключом) — берётся самая свежая запись.
 * Невидимки не публикуют присутствие вовсе, поэтому их здесь нет; запись со статусом
 * «invisible» (например, от старой версии приложения) тоже игнорируется.
 */
export function reduceOnline(state: Record<string, Record<string, unknown>[] | undefined>): Record<string, OnlineStatus> {
  const best = new Map<string, { status: OnlineStatus; at: number }>();
  for (const metas of Object.values(state)) {
    for (const m of metas ?? []) {
      if (!m || !isUserId(m.user_id) || typeof m.status !== 'string' || !VISIBLE.has(m.status)) continue;
      const at = typeof m.at === 'number' ? m.at : 0;
      const prev = best.get(m.user_id);
      if (!prev || at >= prev.at) best.set(m.user_id, { status: m.status as OnlineStatus, at });
    }
  }
  const out: Record<string, OnlineStatus> = {};
  for (const [id, v] of best) out[id] = v.status;
  return out;
}
