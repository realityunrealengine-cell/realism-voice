import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/stores/auth';
import type { Scope } from '@/lib/types';

// Индикатор набора текста через приватный Realtime Broadcast-канал.
export function useTyping(scope: Scope) {
  const me = useAuth((s) => s.userId);
  const [typers, setTypers] = useState<string[]>([]);
  const chRef = useRef<RealtimeChannel | null>(null);
  const expiry = useRef(new Map<string, number>());
  const lastSent = useRef(0);

  useEffect(() => {
    const topic = scope.kind === 'channel' ? `typing:${scope.id}` : `dm:${scope.id}`;
    const ch = supabase.channel(topic, { config: { private: true, broadcast: { self: false } } });
    ch.on('broadcast', { event: 'typing' }, ({ payload }) => {
      const uid = (payload as { user_id?: string })?.user_id;
      if (!uid || uid === me) return;
      expiry.current.set(uid, Date.now() + 6000);
      setTypers([...expiry.current.keys()]);
    });
    ch.on('broadcast', { event: 'stop' }, ({ payload }) => {
      const uid = (payload as { user_id?: string })?.user_id;
      if (uid && expiry.current.delete(uid)) setTypers([...expiry.current.keys()]);
    });
    ch.subscribe();
    chRef.current = ch;
    const timer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [k, t] of expiry.current) {
        if (t < now) {
          expiry.current.delete(k);
          changed = true;
        }
      }
      if (changed) setTypers([...expiry.current.keys()]);
    }, 1000);
    return () => {
      clearInterval(timer);
      expiry.current.clear();
      setTypers([]);
      void supabase.removeChannel(ch);
      chRef.current = null;
    };
  }, [scope.kind, scope.id, me]);

  const notify = useCallback(() => {
    const now = Date.now();
    if (now - lastSent.current < 3000 || !chRef.current) return;
    lastSent.current = now;
    void chRef.current.send({ type: 'broadcast', event: 'typing', payload: { user_id: me } });
  }, [me]);

  const stop = useCallback(() => {
    lastSent.current = 0;
    void chRef.current?.send({ type: 'broadcast', event: 'stop', payload: { user_id: me } });
  }, [me]);

  // Пришло сообщение от пользователя — он больше не печатает
  const clear = useCallback((uid: string) => {
    if (expiry.current.delete(uid)) setTypers([...expiry.current.keys()]);
  }, []);

  return { typers, notify, stop, clear };
}
