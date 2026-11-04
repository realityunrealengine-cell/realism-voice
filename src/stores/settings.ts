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
  screenQuality: '720p' | '1080p' | '1080p60';
  screenAudio: boolean;
  showLinkPreviews: boolean;
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
  screenQuality: '1080p',
  screenAudio: false,
  showLinkPreviews: true,
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
      version: 1,
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
