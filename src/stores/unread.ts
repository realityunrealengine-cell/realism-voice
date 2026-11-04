import { create } from 'zustand';
import { supabase } from '@/lib/supabase';

interface Count {
  unread: number;
  mentions: number;
  serverId: string | null;
}

interface UnreadState {
  counts: Record<string, Count>;
  load: () => Promise<void>;
  bump: (scopeId: string, serverId: string | null, mention: boolean) => void;
  markRead: (scopeId: string) => void;
  reset: () => void;
}

const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Отметка ещё не подтверждена сервером: счётчик с сервера для этих каналов устарел
const unconfirmedReads = new Set<string>();
const lastMarkedAt = new Map<string, number>();

async function sendMarkRead(scopeId: string, attempt = 0): Promise<void> {
  // Запросы Supabase ленивые: без await/then запрос не отправляется
  const { error } = await supabase.rpc('mark_read', { p_scope: scopeId });
  if (error && attempt < 3) {
    setTimeout(() => void sendMarkRead(scopeId, attempt + 1), 5000);
    return;
  }
  if (!readTimers.has(scopeId)) unconfirmedReads.delete(scopeId);
}

export const useUnread = create<UnreadState>((set, get) => ({
  counts: {},
  reset: () => set({ counts: {} }),
  load: async () => {
    const startedAt = Date.now();
    const { data, error } = await supabase.rpc('get_unread_counts');
    if (error || !data) return;
    const counts: Record<string, Count> = {};
    for (const r of data as { scope_id: string; server_id: string | null; unread: number; mentions: number }[]) {
      if (unconfirmedReads.has(r.scope_id) || (lastMarkedAt.get(r.scope_id) ?? 0) >= startedAt) continue;
      counts[r.scope_id] = { unread: r.unread, mentions: r.mentions, serverId: r.server_id };
    }
    set({ counts });
  },
  bump: (scopeId, serverId, mention) => {
    const c = get().counts[scopeId] ?? { unread: 0, mentions: 0, serverId };
    set({ counts: { ...get().counts, [scopeId]: { unread: c.unread + 1, mentions: c.mentions + (mention ? 1 : 0), serverId } } });
  },
  markRead: (scopeId) => {
    if (get().counts[scopeId]) {
      const { [scopeId]: _x, ...rest } = get().counts;
      set({ counts: rest });
    }
    unconfirmedReads.add(scopeId);
    lastMarkedAt.set(scopeId, Date.now());
    // Схлопываем частые вызовы (например, при потоке новых сообщений)
    const t = readTimers.get(scopeId);
    if (t) clearTimeout(t);
    readTimers.set(
      scopeId,
      setTimeout(() => {
        readTimers.delete(scopeId);
        void sendMarkRead(scopeId);
      }, 600),
    );
  },
}));

export function serverUnread(counts: Record<string, Count>, serverId: string, muted: boolean) {
  let unread = 0;
  let mentions = 0;
  for (const c of Object.values(counts)) {
    if (c.serverId === serverId) {
      unread += c.unread;
      mentions += c.mentions;
    }
  }
  return { unread: muted ? 0 : unread, mentions };
}
