// Состояние сети и восстановление после обрыва, сна Windows или блокировки.
// Без постоянного опроса сервера: действия выполняются по событиям (online/offline, resume из сна,
// возврат окна, пропущенный heartbeat Realtime) и по редкому локальному таймеру presence.
import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { deriveSync, type SyncView } from '@/lib/syncStatus';
import { usePresence } from './presence';
import { useVoice } from './voice';

interface ConnectivityState {
  online: boolean;
  /** Система только что вышла из сна — идёт восстановление */
  resuming: boolean;
  /** WebSocket Realtime отвечает на heartbeat */
  socketOk: boolean;
  /** Канал изменений базы (сообщения, серверы, друзья) подписан */
  dataJoined: boolean;
  setDataJoined: (joined: boolean) => void;
  init: () => () => void;
  recover: (reason: string) => Promise<void>;
}

let recovering: Promise<void> | null = null;
let lastHeartbeatRecover = 0;

export const useConnectivity = create<ConnectivityState>((set, get) => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  resuming: false,
  socketOk: true,
  dataJoined: false,

  setDataJoined: (joined) => {
    if (get().dataJoined !== joined) set({ dataJoined: joined });
  },

  init: () => {
    const onOnline = () => {
      set({ online: true });
      void get().recover('online');
    };
    const onOffline = () => set({ online: false });
    const onVisible = () => {
      if (document.visibilityState === 'visible') usePresence.getState().verify();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    const offPower = window.rv?.app.onPower?.((ev) => {
      if (ev === 'resume' || ev === 'unlock-screen') {
        set({ resuming: true });
        void get().recover(ev).finally(() => set({ resuming: false }));
      }
    });
    // Heartbeat Realtime уже идёт каждые 15 с — используем его как бесплатный датчик связи с сервером
    supabase.realtime.onHeartbeat((status) => {
      if (status === 'ok') {
        if (!get().socketOk) {
          set({ socketOk: true });
          usePresence.getState().verify();
        }
      } else if (status === 'timeout' || status === 'error' || status === 'disconnected') {
        set({ socketOk: false });
        const now = Date.now();
        if (now - lastHeartbeatRecover > 10_000) {
          lastHeartbeatRecover = now;
          void get().recover(`heartbeat ${status}`);
        }
      }
    });
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      offPower?.();
    };
  },

  recover: async (reason) => {
    if (recovering) return recovering;
    recovering = (async () => {
      if (import.meta.env.DEV) console.debug('[connectivity] recover:', reason);
      set({ online: navigator.onLine });
      if (!navigator.onLine) return;
      // После сна JWT мог истечь: getSession() обновит его, и Realtime получит новый токен.
      const { data } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
      if (data.session && data.session.expires_at && data.session.expires_at * 1000 < Date.now() + 60_000) {
        await supabase.auth.refreshSession().catch(() => undefined);
      }
      await supabase.realtime.setAuth().catch(() => undefined);
      if (!supabase.realtime.isConnected()) supabase.realtime.connect();
      usePresence.getState().verify(true);
      // Голосовую связь трогаем только если её комната действительно разорвана
      useVoice.getState().onConnectivityRestored();
    })().finally(() => {
      recovering = null;
    });
    return recovering;
  },
}));

/** Состояние синхронизации с сервером для интерфейса */
export function useSyncView(): SyncView {
  const online = useConnectivity((s) => s.online);
  const socketOk = useConnectivity((s) => s.socketOk);
  const dataJoined = useConnectivity((s) => s.dataJoined);
  const presenceJoined = usePresence((s) => s.connected);
  return deriveSync({ online, socketOk, presenceJoined, dataJoined });
}
