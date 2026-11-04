import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { errorMessage } from '@/lib/errors';
import { uploadPublicImage } from '@/lib/media';
import type { Category, Channel, Member, Profile, Server, ServerRole } from '@/lib/types';
import { useProfiles } from './profiles';
import { useAuth } from './auth';

interface ServersState {
  loaded: boolean;
  servers: Server[];
  myRoles: Record<string, ServerRole>;
  categories: Record<string, Category[]>;
  channels: Record<string, Channel[]>;
  members: Record<string, Member[]>;
  membersLoaded: Record<string, boolean>;

  loadAll: () => Promise<void>;
  loadServer: (serverId: string) => Promise<void>;
  loadMembers: (serverId: string) => Promise<void>;
  reset: () => void;

  createServer: (name: string, icon: File | null) => Promise<string>;
  updateServer: (serverId: string, patch: { name: string; description: string; members_can_invite: boolean; icon?: File | null; removeIcon?: boolean }) => Promise<void>;
  deleteServer: (serverId: string) => Promise<void>;
  leaveServer: (serverId: string) => Promise<void>;
  joinServer: (code: string) => Promise<string>;

  createChannel: (serverId: string, input: { name: string; type: 'text' | 'voice'; categoryId: string | null; isPrivate: boolean }) => Promise<Channel>;
  updateChannel: (channelId: string, patch: Partial<Channel>) => Promise<void>;
  deleteChannel: (channelId: string) => Promise<void>;
  createCategory: (serverId: string, name: string) => Promise<void>;
  renameCategory: (categoryId: string, name: string) => Promise<void>;
  deleteCategory: (categoryId: string) => Promise<void>;
  moveChannel: (channelId: string, targetCategoryId: string | null, beforeChannelId: string | null) => Promise<void>;
  moveCategory: (categoryId: string, dir: -1 | 1) => Promise<void>;

  setRole: (serverId: string, userId: string, role: ServerRole) => Promise<void>;
  kick: (serverId: string, userId: string) => Promise<void>;
  ban: (serverId: string, userId: string, reason: string) => Promise<void>;

  applyServer: (ev: 'INSERT' | 'UPDATE' | 'DELETE', row: Partial<Server>) => void;
  applyChannel: (ev: 'INSERT' | 'UPDATE' | 'DELETE', row: Partial<Channel>) => void;
  applyCategory: (ev: 'INSERT' | 'UPDATE' | 'DELETE', row: Partial<Category>) => void;
  applyMember: (ev: 'INSERT' | 'UPDATE' | 'DELETE', row: Partial<Member>) => void;
}

function sortByPos<T extends { position: number; created_at?: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => a.position - b.position || (a.created_at ?? '').localeCompare(b.created_at ?? ''));
}

function groupBy<T extends { server_id: string }>(rows: T[]): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const r of rows) (out[r.server_id] ??= []).push(r);
  return out;
}

function fail(error: unknown): never {
  throw new Error(errorMessage(error));
}

export const useServers = create<ServersState>((set, get) => ({
  loaded: false,
  servers: [],
  myRoles: {},
  categories: {},
  channels: {},
  members: {},
  membersLoaded: {},

  reset: () => set({ loaded: false, servers: [], myRoles: {}, categories: {}, channels: {}, members: {}, membersLoaded: {} }),

  loadAll: async () => {
    const uid = useAuth.getState().userId;
    if (!uid) return;
    const [srv, mine, cats, chans] = await Promise.all([
      supabase.from('servers').select('*').order('created_at'),
      supabase.from('server_members').select('*').eq('user_id', uid),
      supabase.from('categories').select('*'),
      supabase.from('channels').select('*'),
    ]);
    if (srv.error) fail(srv.error);
    const roles: Record<string, ServerRole> = {};
    const joinedAt: Record<string, string> = {};
    for (const m of (mine.data ?? []) as Member[]) {
      roles[m.server_id] = m.role;
      joinedAt[m.server_id] = m.joined_at;
    }
    const servers = ((srv.data ?? []) as Server[]).sort((a, b) =>
      (joinedAt[a.id] ?? a.created_at).localeCompare(joinedAt[b.id] ?? b.created_at),
    );
    const categories = groupBy((cats.data ?? []) as Category[]);
    const channels = groupBy((chans.data ?? []) as Channel[]);
    for (const k of Object.keys(categories)) categories[k] = sortByPos(categories[k]);
    for (const k of Object.keys(channels)) channels[k] = sortByPos(channels[k]);
    set({ servers, myRoles: roles, categories, channels, loaded: true });
  },

  loadServer: async (serverId) => {
    const [srv, cats, chans, me] = await Promise.all([
      supabase.from('servers').select('*').eq('id', serverId).maybeSingle(),
      supabase.from('categories').select('*').eq('server_id', serverId),
      supabase.from('channels').select('*').eq('server_id', serverId),
      supabase.from('server_members').select('*').eq('server_id', serverId).eq('user_id', useAuth.getState().userId ?? '').maybeSingle(),
    ]);
    if (!srv.data) return;
    const s = get();
    const exists = s.servers.some((x) => x.id === serverId);
    set({
      servers: exists ? s.servers.map((x) => (x.id === serverId ? (srv.data as Server) : x)) : [...s.servers, srv.data as Server],
      categories: { ...s.categories, [serverId]: sortByPos((cats.data ?? []) as Category[]) },
      channels: { ...s.channels, [serverId]: sortByPos((chans.data ?? []) as Channel[]) },
      myRoles: me.data ? { ...s.myRoles, [serverId]: (me.data as Member).role } : s.myRoles,
    });
  },

  loadMembers: async (serverId) => {
    const { data, error } = await supabase
      .from('server_members')
      .select('*, profile:profiles(*)')
      .eq('server_id', serverId)
      .limit(5000);
    if (error) return;
    const rows = (data ?? []) as (Member & { profile: Profile | null })[];
    useProfiles.getState().upsert(rows.map((r) => r.profile).filter((p): p is Profile => !!p));
    set({
      members: { ...get().members, [serverId]: rows.map(({ profile: _p, ...m }) => m) },
      membersLoaded: { ...get().membersLoaded, [serverId]: true },
    });
  },

  createServer: async (name, icon) => {
    const { data, error } = await supabase.rpc('create_server', { p_name: name.trim(), p_description: '' });
    if (error) fail(error);
    const id = data as string;
    if (icon) {
      try {
        const path = await uploadPublicImage('server-icons', id, icon);
        await supabase.rpc('update_server', {
          p_server: id, p_name: name.trim(), p_description: '', p_icon_path: path, p_members_can_invite: true,
        });
      } catch {
        /* иконку можно загрузить позже в настройках */
      }
    }
    await get().loadServer(id);
    return id;
  },

  updateServer: async (serverId, patch) => {
    const server = get().servers.find((s) => s.id === serverId);
    if (!server) return;
    let iconPath = patch.removeIcon ? null : server.icon_path;
    if (patch.icon) iconPath = await uploadPublicImage('server-icons', serverId, patch.icon);
    const { error } = await supabase.rpc('update_server', {
      p_server: serverId,
      p_name: patch.name.trim(),
      p_description: patch.description,
      p_icon_path: iconPath,
      p_members_can_invite: patch.members_can_invite,
    });
    if (error) fail(error);
    if (server.icon_path && server.icon_path !== iconPath) {
      void supabase.storage.from('server-icons').remove([server.icon_path]);
    }
    get().applyServer('UPDATE', {
      ...server, name: patch.name.trim(), description: patch.description, icon_path: iconPath, members_can_invite: patch.members_can_invite,
    });
  },

  deleteServer: async (serverId) => {
    const { error } = await supabase.rpc('delete_server', { p_server: serverId });
    if (error) fail(error);
    get().applyServer('DELETE', { id: serverId });
  },

  leaveServer: async (serverId) => {
    const { error } = await supabase.rpc('leave_server', { p_server: serverId });
    if (error) fail(error);
    get().applyServer('DELETE', { id: serverId });
  },

  joinServer: async (code) => {
    const { data, error } = await supabase.rpc('join_server', { p_code: code.trim() });
    if (error) fail(error);
    await get().loadServer(data as string);
    return data as string;
  },

  createChannel: async (serverId, input) => {
    const list = get().channels[serverId] ?? [];
    const position = Math.max(-1, ...list.filter((c) => c.category_id === input.categoryId).map((c) => c.position)) + 1;
    const { data, error } = await supabase
      .from('channels')
      .insert({
        server_id: serverId,
        name: input.name.trim(),
        type: input.type,
        category_id: input.categoryId,
        is_private: input.isPrivate,
        min_role: input.isPrivate ? 'moderator' : 'member',
        position,
      })
      .select('*')
      .single();
    if (error) fail(error);
    get().applyChannel('INSERT', data as Channel);
    return data as Channel;
  },

  updateChannel: async (channelId, patch) => {
    const { id: _id, server_id: _s, created_at: _c, type: _t, ...rest } = patch;
    const { data, error } = await supabase.from('channels').update(rest).eq('id', channelId).select('*').single();
    if (error) fail(error);
    get().applyChannel('UPDATE', data as Channel);
  },

  deleteChannel: async (channelId) => {
    const { error } = await supabase.from('channels').delete().eq('id', channelId);
    if (error) fail(error);
    get().applyChannel('DELETE', { id: channelId });
  },

  createCategory: async (serverId, name) => {
    const position = Math.max(-1, ...(get().categories[serverId] ?? []).map((c) => c.position)) + 1;
    const { data, error } = await supabase
      .from('categories')
      .insert({ server_id: serverId, name: name.trim(), position })
      .select('*')
      .single();
    if (error) fail(error);
    get().applyCategory('INSERT', data as Category);
  },

  renameCategory: async (categoryId, name) => {
    const { data, error } = await supabase.from('categories').update({ name: name.trim() }).eq('id', categoryId).select('*').single();
    if (error) fail(error);
    get().applyCategory('UPDATE', data as Category);
  },

  deleteCategory: async (categoryId) => {
    const { error } = await supabase.from('categories').delete().eq('id', categoryId);
    if (error) fail(error);
    get().applyCategory('DELETE', { id: categoryId });
  },

  moveChannel: async (channelId, targetCategoryId, beforeChannelId) => {
    const all = Object.values(get().channels).flat();
    const ch = all.find((c) => c.id === channelId);
    if (!ch || channelId === beforeChannelId) return;
    const serverId = ch.server_id;
    const siblings = sortByPos((get().channels[serverId] ?? []).filter((c) => c.category_id === targetCategoryId && c.id !== channelId));
    const idx = beforeChannelId ? siblings.findIndex((c) => c.id === beforeChannelId) : -1;
    const ordered = [...siblings];
    ordered.splice(idx >= 0 ? idx : ordered.length, 0, { ...ch, category_id: targetCategoryId });
    const items = ordered.map((c, i) => ({ id: c.id, position: i, category_id: targetCategoryId }));
    // Оптимистично
    const updated = (get().channels[serverId] ?? []).map((c) => {
      const it = items.find((x) => x.id === c.id);
      return it ? { ...c, position: it.position, category_id: it.category_id } : c;
    });
    set({ channels: { ...get().channels, [serverId]: sortByPos(updated) } });
    const { error } = await supabase.rpc('reorder_channels', { p_server: serverId, p_items: items });
    if (error) {
      await get().loadServer(serverId);
      fail(error);
    }
  },

  moveCategory: async (categoryId, dir) => {
    const all = Object.values(get().categories).flat();
    const cat = all.find((c) => c.id === categoryId);
    if (!cat) return;
    const list = sortByPos(get().categories[cat.server_id] ?? []);
    const i = list.findIndex((c) => c.id === categoryId);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    const items = list.map((c, k) => ({ id: c.id, position: k }));
    set({ categories: { ...get().categories, [cat.server_id]: list.map((c, k) => ({ ...c, position: k })) } });
    const { error } = await supabase.rpc('reorder_categories', { p_server: cat.server_id, p_items: items });
    if (error) {
      await get().loadServer(cat.server_id);
      fail(error);
    }
  },

  setRole: async (serverId, userId, role) => {
    const { error } = await supabase.rpc('set_member_role', { p_server: serverId, p_user: userId, p_role: role });
    if (error) fail(error);
    get().applyMember('UPDATE', { server_id: serverId, user_id: userId, role });
  },

  kick: async (serverId, userId) => {
    const { error } = await supabase.rpc('kick_member', { p_server: serverId, p_user: userId });
    if (error) fail(error);
    get().applyMember('DELETE', { server_id: serverId, user_id: userId });
  },

  ban: async (serverId, userId, reason) => {
    const { error } = await supabase.rpc('ban_member', { p_server: serverId, p_user: userId, p_reason: reason });
    if (error) fail(error);
    get().applyMember('DELETE', { server_id: serverId, user_id: userId });
  },

  applyServer: (ev, row) => {
    const s = get();
    if (!row.id) return;
    if (ev === 'DELETE') {
      const { [row.id]: _c, ...categories } = s.categories;
      const { [row.id]: _ch, ...channels } = s.channels;
      const { [row.id]: _r, ...myRoles } = s.myRoles;
      set({ servers: s.servers.filter((x) => x.id !== row.id), categories, channels, myRoles });
      return;
    }
    if (s.servers.some((x) => x.id === row.id)) {
      set({ servers: s.servers.map((x) => (x.id === row.id ? { ...x, ...row } : x)) });
    } else if (ev === 'INSERT' || ev === 'UPDATE') {
      void get().loadServer(row.id);
    }
  },

  applyChannel: (ev, row) => {
    const s = get();
    if (!row.id) return;
    if (ev === 'DELETE') {
      const next: Record<string, Channel[]> = {};
      for (const [k, list] of Object.entries(s.channels)) next[k] = list.filter((c) => c.id !== row.id);
      set({ channels: next });
      return;
    }
    const ch = row as Channel;
    if (!ch.server_id) return;
    const list = (s.channels[ch.server_id] ?? []).filter((c) => c.id !== ch.id);
    set({ channels: { ...s.channels, [ch.server_id]: sortByPos([...list, ch]) } });
  },

  applyCategory: (ev, row) => {
    const s = get();
    if (!row.id) return;
    if (ev === 'DELETE') {
      const next: Record<string, Category[]> = {};
      for (const [k, list] of Object.entries(s.categories)) next[k] = list.filter((c) => c.id !== row.id);
      const chans: Record<string, Channel[]> = {};
      for (const [k, list] of Object.entries(s.channels))
        chans[k] = list.map((c) => (c.category_id === row.id ? { ...c, category_id: null } : c));
      set({ categories: next, channels: chans });
      return;
    }
    const cat = row as Category;
    if (!cat.server_id) return;
    const list = (s.categories[cat.server_id] ?? []).filter((c) => c.id !== cat.id);
    set({ categories: { ...s.categories, [cat.server_id]: sortByPos([...list, cat]) } });
  },

  applyMember: (ev, row) => {
    const s = get();
    const uid = useAuth.getState().userId;
    if (!row.server_id || !row.user_id) return;
    if (ev === 'DELETE') {
      if (row.user_id === uid) {
        get().applyServer('DELETE', { id: row.server_id });
        return;
      }
      if (s.members[row.server_id])
        set({ members: { ...s.members, [row.server_id]: s.members[row.server_id].filter((m) => m.user_id !== row.user_id) } });
      return;
    }
    const m = row as Member;
    if (m.user_id === uid) {
      const hadRole = s.myRoles[m.server_id];
      set({ myRoles: { ...s.myRoles, [m.server_id]: m.role ?? hadRole } });
      // Роль изменилась — видимость приватных каналов могла поменяться
      if (hadRole !== m.role || !s.servers.some((x) => x.id === m.server_id)) void get().loadServer(m.server_id);
    }
    useProfiles.getState().ensure([m.user_id]);
    if (s.members[m.server_id]) {
      const list = s.members[m.server_id];
      const exists = list.some((x) => x.user_id === m.user_id);
      set({
        members: {
          ...s.members,
          [m.server_id]: exists ? list.map((x) => (x.user_id === m.user_id ? { ...x, ...m } : x)) : [...list, m],
        },
      });
    }
  },
}));
