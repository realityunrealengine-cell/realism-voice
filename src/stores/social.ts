import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { errorMessage } from '@/lib/errors';
import type { DmConversation, Friendship, Profile } from '@/lib/types';
import { useAuth } from './auth';
import { useProfiles } from './profiles';

interface SocialState {
  friendships: Friendship[];
  blocked: string[];
  dms: DmConversation[];
  loaded: boolean;
  load: () => Promise<void>;
  reset: () => void;
  sendRequest: (username: string) => Promise<string>;
  respond: (id: string, accept: boolean) => Promise<void>;
  removeFriend: (userId: string) => Promise<void>;
  block: (userId: string) => Promise<void>;
  unblock: (userId: string) => Promise<void>;
  openDm: (userId: string) => Promise<string>;
  searchUsers: (q: string) => Promise<Profile[]>;
  applyFriendship: (ev: 'INSERT' | 'UPDATE' | 'DELETE', row: Partial<Friendship>) => void;
  applyDm: (ev: 'INSERT' | 'UPDATE' | 'DELETE', row: Partial<DmConversation>) => void;
  applyBlock: (ev: 'INSERT' | 'UPDATE' | 'DELETE', row: { blocker_id?: string; blocked_id?: string }) => void;
}

export function otherUser(f: Pick<Friendship, 'requester_id' | 'addressee_id'>, me: string): string {
  return f.requester_id === me ? f.addressee_id : f.requester_id;
}

export function dmPeer(d: Pick<DmConversation, 'user_low' | 'user_high'>, me: string): string {
  return d.user_low === me ? d.user_high : d.user_low;
}

function fail(error: unknown): never {
  throw new Error(errorMessage(error));
}

export const useSocial = create<SocialState>((set, get) => ({
  friendships: [],
  blocked: [],
  dms: [],
  loaded: false,

  reset: () => set({ friendships: [], blocked: [], dms: [], loaded: false }),

  load: async () => {
    const me = useAuth.getState().userId;
    if (!me) return;
    const [f, b, d] = await Promise.all([
      supabase.from('friendships').select('*'),
      supabase.from('blocks').select('blocked_id').eq('blocker_id', me),
      supabase.from('dm_conversations').select('*').order('last_message_at', { ascending: false }).limit(200),
    ]);
    const friendships = (f.data ?? []) as Friendship[];
    const dms = (d.data ?? []) as DmConversation[];
    useProfiles.getState().ensure([...friendships.map((x) => otherUser(x, me)), ...dms.map((x) => dmPeer(x, me))]);
    const blocked = ((b.data ?? []) as { blocked_id: string }[]).map((x) => x.blocked_id);
    useProfiles.getState().ensure(blocked);
    set({ friendships, blocked, dms, loaded: true });
  },

  sendRequest: async (username) => {
    const { data, error } = await supabase.rpc('send_friend_request', { p_username: username.trim().replace(/^@/, '') });
    if (error) fail(error);
    await get().load();
    return data as string;
  },

  respond: async (id, accept) => {
    const { error } = await supabase.rpc('respond_friend_request', { p_id: id, p_accept: accept });
    if (error) fail(error);
    if (accept) {
      set({
        friendships: get().friendships.map((f) => (f.id === id ? { ...f, status: 'accepted', accepted_at: new Date().toISOString() } : f)),
      });
    } else {
      set({ friendships: get().friendships.filter((f) => f.id !== id) });
    }
  },

  removeFriend: async (userId) => {
    const { error } = await supabase.rpc('remove_friend', { p_user: userId });
    if (error) fail(error);
    const me = useAuth.getState().userId!;
    set({ friendships: get().friendships.filter((f) => otherUser(f, me) !== userId) });
  },

  block: async (userId) => {
    const { error } = await supabase.rpc('block_user', { p_user: userId });
    if (error) fail(error);
    const me = useAuth.getState().userId!;
    set({
      blocked: [...new Set([...get().blocked, userId])],
      friendships: get().friendships.filter((f) => otherUser(f, me) !== userId),
    });
  },

  unblock: async (userId) => {
    const { error } = await supabase.rpc('unblock_user', { p_user: userId });
    if (error) fail(error);
    set({ blocked: get().blocked.filter((x) => x !== userId) });
  },

  openDm: async (userId) => {
    const { data, error } = await supabase.rpc('open_dm', { p_user: userId });
    if (error) fail(error);
    const id = data as string;
    if (!get().dms.some((d) => d.id === id)) {
      const { data: row } = await supabase.from('dm_conversations').select('*').eq('id', id).single();
      if (row) get().applyDm('INSERT', row as DmConversation);
    }
    return id;
  },

  searchUsers: async (q) => {
    // Оставляем только безопасные символы: запятые/скобки сломали бы синтаксис фильтра PostgREST
    const term = q.trim().toLowerCase().replace(/^@/, '').replace(/[^\p{L}\p{N}. -]/gu, '').slice(0, 32);
    if (term.length < 2) return [];
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .or(`username.ilike.${term}%,display_name.ilike.%${term}%`)
      .limit(20);
    const rows = (data ?? []) as Profile[];
    useProfiles.getState().upsert(rows);
    return rows;
  },

  applyFriendship: (ev, row) => {
    const me = useAuth.getState().userId;
    if (!row.id || !me) return;
    if (ev === 'DELETE') {
      set({ friendships: get().friendships.filter((f) => f.id !== row.id) });
      return;
    }
    const f = row as Friendship;
    useProfiles.getState().ensure([otherUser(f, me)]);
    const rest = get().friendships.filter((x) => x.id !== f.id);
    set({ friendships: [...rest, f] });
  },

  applyDm: (ev, row) => {
    const me = useAuth.getState().userId;
    if (!row.id || !me) return;
    if (ev === 'DELETE') {
      set({ dms: get().dms.filter((d) => d.id !== row.id) });
      return;
    }
    const d = row as DmConversation;
    useProfiles.getState().ensure([dmPeer(d, me)]);
    const rest = get().dms.filter((x) => x.id !== d.id);
    set({ dms: [d, ...rest].sort((a, b) => b.last_message_at.localeCompare(a.last_message_at)) });
  },

  applyBlock: (ev, row) => {
    const me = useAuth.getState().userId;
    if (ev === 'DELETE') {
      // DELETE содержит только первичный ключ
      if (row.blocker_id === me && row.blocked_id) set({ blocked: get().blocked.filter((x) => x !== row.blocked_id) });
      return;
    }
    if (row.blocker_id === me && row.blocked_id) set({ blocked: [...new Set([...get().blocked, row.blocked_id])] });
  },
}));
