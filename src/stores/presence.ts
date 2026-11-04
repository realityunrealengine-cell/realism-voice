// Онлайн-статусы и «кто в голосовом канале» через Supabase Realtime Presence.
// Каналы приватные — доступ проверяется политиками realtime.messages (Realtime Authorization).
import { create } from 'zustand';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { PresenceStatus } from '@/lib/types';

export interface VoiceMember {
  user_id: string;
  channel_id: string;
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  screen: boolean;
}

interface PresenceState {
  online: Record<string, Exclude<PresenceStatus, 'invisible'>>;
  voice: Record<string, VoiceMember[]>; // serverId -> участники
  connected: boolean;
  start: (userId: string, status: PresenceStatus) => void;
  setStatus: (status: PresenceStatus) => void;
  stop: () => void;
  watchVoice: (serverIds: string[]) => void;
  trackVoice: (serverId: string | null, state: Omit<VoiceMember, 'user_id'> | null) => void;
}

let globalChannel: RealtimeChannel | null = null;
let myId: string | null = null;
let myStatus: PresenceStatus = 'online';
const voiceChannels = new Map<string, RealtimeChannel>();
let trackedVoice: { serverId: string; state: Omit<VoiceMember, 'user_id'> } | null = null;

export const usePresence = create<PresenceState>((set, get) => {
  const syncVoice = (serverId: string, ch: RealtimeChannel) => {
    const state = ch.presenceState<VoiceMember>();
    const list: VoiceMember[] = [];
    const seen = new Set<string>();
    for (const metas of Object.values(state)) {
      const m = metas[metas.length - 1];
      if (m && m.user_id && !seen.has(m.user_id)) {
        seen.add(m.user_id);
        list.push({
          user_id: m.user_id, channel_id: m.channel_id, muted: !!m.muted, deafened: !!m.deafened, camera: !!m.camera, screen: !!m.screen,
        });
      }
    }
    set({ voice: { ...get().voice, [serverId]: list } });
  };

  const openVoice = (serverId: string) => {
    if (voiceChannels.has(serverId)) return;
    const ch = supabase.channel(`voice:${serverId}`, { config: { private: true, presence: { key: myId ?? undefined } } });
    ch.on('presence', { event: 'sync' }, () => syncVoice(serverId, ch));
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED' && trackedVoice?.serverId === serverId && myId) {
        void ch.track({ user_id: myId, ...trackedVoice.state });
      }
    });
    voiceChannels.set(serverId, ch);
  };

  return {
    online: {},
    voice: {},
    connected: false,

    start: (userId, status) => {
      myId = userId;
      myStatus = status;
      if (globalChannel) return;
      globalChannel = supabase.channel('presence:global', { config: { private: true, presence: { key: userId } } });
      globalChannel.on('presence', { event: 'sync' }, () => {
        const state = globalChannel!.presenceState<{ user_id: string; status: PresenceStatus }>();
        const online: PresenceState['online'] = {};
        for (const metas of Object.values(state)) {
          const m = metas[metas.length - 1];
          if (m?.user_id && m.status !== 'invisible') online[m.user_id] = m.status as Exclude<PresenceStatus, 'invisible'>;
        }
        set({ online });
      });
      globalChannel.subscribe((s) => {
        set({ connected: s === 'SUBSCRIBED' });
        if (s === 'SUBSCRIBED' && myStatus !== 'invisible') {
          void globalChannel!.track({ user_id: userId, status: myStatus });
        }
      });
    },

    setStatus: (status) => {
      myStatus = status;
      if (!globalChannel || !myId) return;
      if (status === 'invisible') void globalChannel.untrack();
      else void globalChannel.track({ user_id: myId, status });
    },

    stop: () => {
      if (globalChannel) void supabase.removeChannel(globalChannel);
      globalChannel = null;
      for (const ch of voiceChannels.values()) void supabase.removeChannel(ch);
      voiceChannels.clear();
      trackedVoice = null;
      myId = null;
      set({ online: {}, voice: {}, connected: false });
    },

    watchVoice: (serverIds) => {
      const wanted = new Set(serverIds.filter(Boolean));
      if (trackedVoice) wanted.add(trackedVoice.serverId);
      for (const [id, ch] of voiceChannels) {
        if (!wanted.has(id)) {
          void supabase.removeChannel(ch);
          voiceChannels.delete(id);
          const { [id]: _x, ...rest } = get().voice;
          set({ voice: rest });
        }
      }
      for (const id of wanted) openVoice(id);
    },

    trackVoice: (serverId, state) => {
      const prev = trackedVoice;
      if (prev && (!serverId || prev.serverId !== serverId)) {
        void voiceChannels.get(prev.serverId)?.untrack();
      }
      trackedVoice = serverId && state ? { serverId, state } : null;
      if (serverId && state && myId) {
        const ch = voiceChannels.get(serverId);
        if (ch) void ch.track({ user_id: myId, ...state });
        else openVoice(serverId);
      }
    },
  };
});

export function effectiveStatus(online: PresenceState['online'], userId: string): PresenceStatus | 'offline' {
  return online[userId] ?? 'offline';
}
