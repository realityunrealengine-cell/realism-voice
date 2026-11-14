// Подключение Supabase Realtime для комнаты голосовой связи — своё у КАЖДОГО голосового сеанса.
//
// Почему не общее: supabase.channel(topic) возвращает уже существующий канал с той же темой. Если прошлый
// сеанс ещё не успел закрыть свой канал (повтор, переподключение, быстрый перезаход в звонок), новый сеанс
// получал старый, уже подписанный канал и падал с ошибкой «cannot add presence callbacks … after subscribe()».
// Отдельный клиент на сеанс исключает это полностью; при закрытии сеанса соединение закрывается.
// Права доступа те же: JWT пользователя и политики Realtime (темы typing:<канал> и dm:<переписка>).
import { createClient } from '@supabase/supabase-js';
import { supabase, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '@/lib/supabase';
import type { RtChannel, RtClient } from '@/lib/presenceChannel';

export interface VoiceRtClient extends RtClient {
  /** Закрыть соединение сеанса */
  dispose(): void;
}

export function voiceRealtime(): VoiceRtClient {
  const client = createClient(SUPABASE_URL || 'https://invalid.supabase.co', SUPABASE_PUBLISHABLE_KEY || 'invalid', {
    accessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
    realtime: { params: { eventsPerSecond: 20 }, heartbeatIntervalMs: 15_000 },
  });
  const rt = client as unknown as RtClient;
  return {
    channel: (topic, opts) => rt.channel(topic, opts),
    removeChannel: (ch: RtChannel) => rt.removeChannel(ch),
    dispose: () => {
      void client.removeAllChannels().catch(() => undefined);
      try {
        client.realtime.disconnect();
      } catch {
        /* уже закрыто */
      }
    },
  };
}
