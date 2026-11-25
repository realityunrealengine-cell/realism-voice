import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppSettings, PttBinding } from '../../electron/shared';

export type AccentTheme = 'violet' | 'blue' | 'pink' | 'emerald';

export interface Prefs {
  inputDeviceId: string;
  outputDeviceId: string;
  videoDeviceId: string;
  inputVolume: number; // 0..200 %
  outputVolume: number; // 0..200 %
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  voiceMode: 'vad' | 'ptt';
  vadThreshold: number; // дБ, -90..-10
  pttReleaseDelay: number; // мс
  pttBinding: PttBinding;
  userVolumes: Record<string, number>; // 0..200 %
  sounds: boolean;
  notifications: {
    desktop: boolean;
    dms: boolean;
    friendRequests: boolean;
    serverMode: 'all' | 'mentions' | 'none';
    flash: boolean;
    mutedServers: string[];
  };
  appearance: {
    accent: AccentTheme;
    compact: boolean;
    fontScale: number; // 90..120
    reduceMotion: boolean;
    glass: boolean;
  };
  cameraQuality: '480p' | '720p' | '1080p';
  screenQuality: '720p' | '1080p' | '1080p60' | '1440p60';
  screenAudio: boolean;
  showLinkPreviews: boolean;
  /** Личные звонки напрямую (P2P); если не получилось — через сервер */
  callP2p: boolean;
  /** Не раскрывать свой IP собеседнику: прямые соединения только через TURN */
  p2pRelayOnly: boolean;
  /** Доставка личных сообщений: сначала P2P / только P2P / только сервер */
  messageMode: 'auto' | 'p2p' | 'server';
}

export const DEFAULT_PREFS: Prefs = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  videoDeviceId: '',
  inputVolume: 100,
  outputVolume: 100,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  voiceMode: 'vad',
  vadThreshold: -55,
  pttReleaseDelay: 200,
  pttBinding: { code: 'Backquote', label: '`' },
  userVolumes: {},
  sounds: true,
  notifications: {
    desktop: true,
    dms: true,
    friendRequests: true,
    serverMode: 'mentions',
    flash: true,
    mutedServers: [],
  },
  appearance: {
    accent: 'violet',
    compact: false,
    fontScale: 100,
    reduceMotion: false,
    glass: true,
  },
  cameraQuality: '720p',
  screenQuality: '1440p60',
  screenAudio: false,
  showLinkPreviews: true,
  callP2p: true,
  p2pRelayOnly: false,
  // Сообщения по умолчанию — как раньше, через сервер: P2P-сообщения хранятся только на устройствах
  // собеседников, и пользователь включает это сознательно (см. «Сеть и P2P»)
  messageMode: 'server',
};

interface SettingsState {
  prefs: Prefs;
  app: AppSettings | null;
  setPrefs: (patch: Partial<Prefs>) => void;
  setNotifications: (patch: Partial<Prefs['notifications']>) => void;
  setAppearance: (patch: Partial<Prefs['appearance']>) => void;
  setUserVolume: (userId: string, volume: number) => void;
  loadApp: () => Promise<void>;
  setApp: (patch: Partial<AppSettings>) => Promise<void>;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      prefs: DEFAULT_PREFS,
      app: null,
      setPrefs: (patch) => set({ prefs: { ...get().prefs, ...patch } }),
      setNotifications: (patch) =>
        set({ prefs: { ...get().prefs, notifications: { ...get().prefs.notifications, ...patch } } }),
      setAppearance: (patch) =>
        set({ prefs: { ...get().prefs, appearance: { ...get().prefs.appearance, ...patch } } }),
      setUserVolume: (userId, volume) =>
        set({ prefs: { ...get().prefs, userVolumes: { ...get().prefs.userVolumes, [userId]: volume } } }),
      loadApp: async () => {
        if (!window.rv) return;
        set({ app: await window.rv.app.getSettings() });
      },
      setApp: async (patch) => {
        if (!window.rv) return;
        set({ app: await window.rv.app.setSettings(patch) });
      },
    }),
    {
      name: 'rv-prefs',
      version: 2,
      // 1.2.3: качество демонстрации по умолчанию — 1440p 60 к/с (прежнее значение по умолчанию заменяется)
      migrate: (persisted, version) => {
        const st = (persisted ?? {}) as { prefs?: Partial<Prefs> };
        if (version < 2 && st.prefs && (st.prefs.screenQuality === undefined || st.prefs.screenQuality === '1080p')) {
          st.prefs = { ...st.prefs, screenQuality: '1440p60' };
        }
        return st as unknown as SettingsState;
      },
      partialize: (s) => ({ prefs: s.prefs }),
      merge: (persisted, current) => {
        const p = (persisted as { prefs?: Partial<Prefs> })?.prefs ?? {};
        return {
          ...current,
          prefs: {
            ...DEFAULT_PREFS,
            ...p,
            notifications: { ...DEFAULT_PREFS.notifications, ...(p.notifications ?? {}) },
            appearance: { ...DEFAULT_PREFS.appearance, ...(p.appearance ?? {}) },
          },
        };
      },
    },
  ),
);

export const ACCENTS: Record<AccentTheme, { a1: string; a2: string; label: string }> = {
  violet: { a1: '#5b7cfa', a2: '#a855f7', label: 'Сине-фиолетовый' },
  blue: { a1: '#3b82f6', a2: '#06b6d4', label: 'Лазурный' },
  pink: { a1: '#8b5cf6', a2: '#ec4899', label: 'Неон' },
  emerald: { a1: '#10b981', a2: '#3b82f6', label: 'Изумрудный' },
};
