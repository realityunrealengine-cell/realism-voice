// Отдельное подключение Supabase Realtime для комнаты голосовой связи.
//
// Почему отдельное: supabase.channel(topic) возвращает уже существующий канал с той же темой, а темы
// `typing:<канал>` и `dm:<переписка>` использует индикатор набора текста. Собственный клиент даёт
// независимый канал с теми же правами доступа (тот же JWT пользователя, те же политики Realtime).
// Соединение открывается только на время голосового сеанса и закрывается вместе с последним каналом.
import { createClient } from '@supabase/supabase-js';
import { supabase, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '@/lib/supabase';
import type { RtClient } from '@/lib/presenceChannel';

let client: RtClient | null = null;

export function voiceRealtime(): RtClient {
  client ??= createClient(SUPABASE_URL || 'https://invalid.supabase.co', SUPABASE_PUBLISHABLE_KEY || 'invalid', {
    accessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
    realtime: { params: { eventsPerSecond: 20 }, heartbeatIntervalMs: 15_000 },
  }) as unknown as RtClient;
  return client;
}
