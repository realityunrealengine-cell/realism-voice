// Онлайн-статусы и «кто в голосовом канале» через Supabase Realtime Presence.
// Каналы приватные — доступ проверяется политиками realtime.messages (Realtime Authorization).
// Надёжность обеспечивает SupervisedChannel: он пересоздаёт закрытые сервером каналы и восстанавливает
// собственную запись присутствия, если сервер её потерял (обрыв сети, сон Windows, истёкший токен).
import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import type { PresenceStatus } from '@/lib/types';
import { SupervisedChannel, type RtClient } from '@/lib/presenceChannel';
import { reduceVoicePresence, type VoiceMember, type VoicePresenceMeta } from '@/lib/voiceRoster';
import { reduceOnline, type OnlineStatus } from '@/lib/onlineStatus';

export type { VoiceMember } from '@/lib/voiceRoster';

export type VoiceSelfState = Omit<VoiceMember, 'user_id' | 'joined_at'>;

interface PresenceState {
  online: Record<string, OnlineStatus>;
  voice: Record<string, VoiceMember[]>; // serverId -> участники голосовых каналов
  /** Канал онлайн-статусов подключён (сервер видит этот клиент) */
  connected: boolean;
  start: (userId: string, status: PresenceStatus) => void;
  setStatus: (status: PresenceStatus) => void;
  stop: () => Promise<void>;
  watchVoice: (serverIds: string[]) => void;
  trackVoice: (serverId: string | null, state: VoiceSelfState | null) => void;
  /** Сверка и восстановление всех каналов (после сна, восстановления сети, по таймеру) */
  verify: (force?: boolean) => void;
}

/** Уникален для каждого запуска приложения: отличает наши записи от записей других устройств */
const SESSION = crypto.randomUUID();
const WATCHDOG_MS = 20_000;
const client = supabase as unknown as RtClient;

let globalCh: SupervisedChannel | null = null;
let myId: string | null = null;
let myStatus: PresenceStatus = 'online';
let wantedVoice: string[] = [];
const voiceChannels = new Map<string, SupervisedChannel>();
let trackedVoice: { serverId: string; state: VoiceSelfState; joinedAt: number } | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;

const log = (msg: string) => {
  if (import.meta.env.DEV) console.debug('[presence]', msg);
};

export const usePresence = create<PresenceState>((set, get) => {
  const globalPayload = () =>
    myId && myStatus !== 'invisible' ? { user_id: myId, status: myStatus, at: Date.now() } : null;

  const voicePayload = (serverId: string) =>
    myId && trackedVoice?.serverId === serverId
      ? { user_id: myId, ...trackedVoice.state, joined_at: trackedVoice.joinedAt, at: Date.now() }
      : null;

  const openVoice = (serverId: string) => {
    if (!myId || voiceChannels.has(serverId)) return;
    const ch = new SupervisedChannel({
      client,
      topic: `voice:${serverId}`,
      key: myId,
      session: SESSION,
      log,
      onSync: (state) => set({ voice: { ...get().voice, [serverId]: reduceVoicePresence(state as Record<string, VoicePresenceMeta[]>) } }),
    });
    voiceChannels.set(serverId, ch);
    ch.setPayload(voicePayload(serverId));
    ch.start();
  };

  const applyVoiceWatch = () => {
    if (!myId) return;
    const wanted = new Set(wantedVoice.filter(Boolean));
    if (trackedVoice) wanted.add(trackedVoice.serverId);
    for (const [id, ch] of voiceChannels) {
      if (!wanted.has(id)) {
        voiceChannels.delete(id);
        void ch.stop();
        const { [id]: _x, ...rest } = get().voice;
        set({ voice: rest });
      }
    }
    for (const id of wanted) openVoice(id);
  };

  return {
    online: {},
    voice: {},
    connected: false,

    start: (userId, status) => {
      if (myId && myId !== userId) void get().stop();
      myId = userId;
      myStatus = status;
      if (!globalCh) {
        globalCh = new SupervisedChannel({
          client,
          topic: 'presence:global',
          key: userId,
          session: SESSION,
          log,
          onSync: (state) => set({ online: reduceOnline(state) }),
          onJoinedChange: (joined) => set({ connected: joined }),
        });
        globalCh.setPayload(globalPayload());
        globalCh.start();
      }
      applyVoiceWatch();
      watchdog ??= setInterval(() => get().verify(), WATCHDOG_MS);
    },

    setStatus: (status) => {
      if (status === myStatus) return;
      myStatus = status;
      globalCh?.setPayload(globalPayload());
    },

    stop: async () => {
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      const all = [globalCh, ...voiceChannels.values()].filter((c): c is SupervisedChannel => !!c);
      globalCh = null;
      voiceChannels.clear();
      trackedVoice = null;
      myId = null;
      set({ online: {}, voice: {}, connected: false });
      await Promise.all(all.map((c) => c.stop()));
    },

    watchVoice: (serverIds) => {
      wantedVoice = serverIds;
      applyVoiceWatch();
    },

    trackVoice: (serverId, state) => {
      const prev = trackedVoice;
      if (serverId && state) {
        const same = prev?.serverId === serverId && prev.state.channel_id === state.channel_id;
        trackedVoice = { serverId, state, joinedAt: same ? prev!.joinedAt : Date.now() };
      } else {
        trackedVoice = null;
      }
      if (prev && prev.serverId !== serverId) voiceChannels.get(prev.serverId)?.setPayload(null);
      if (serverId) {
        const ch = voiceChannels.get(serverId);
        if (ch) ch.setPayload(voicePayload(serverId));
      }
      applyVoiceWatch();
    },

    verify: (force = false) => {
      for (const ch of [globalCh, ...voiceChannels.values()]) {
        if (!ch) continue;
        if (force && !ch.isJoined) ch.reconnectNow();
        else ch.check();
      }
    },
  };
});

export function effectiveStatus(online: PresenceState['online'], userId: string): PresenceStatus | 'offline' {
  return online[userId] ?? 'offline';
}
