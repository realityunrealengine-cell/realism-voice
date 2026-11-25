import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { errorMessage } from '@/lib/errors';
import { attachmentUsage, removeAttachments } from '@/lib/media';
import type { Message, Scope } from '@/lib/types';
import { createOutgoingMessages, type OutgoingActions } from './outgoingMessages';
import { useAuth } from './auth';
import { useProfiles } from './profiles';

const PAGE = 50;

export interface ScopeMessages {
  messages: Message[]; // по возрастанию created_at
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

const EMPTY: ScopeMessages = { messages: [], hasMore: true, loading: false, loaded: false, error: null };

interface MessagesState extends OutgoingActions {
  byScope: Record<string, ScopeMessages>;
  extra: Record<string, Message>; // сообщения, на которые отвечают, но которые не загружены
  load: (scope: Scope) => Promise<void>;
  loadOlder: (scope: Scope) => Promise<void>;
  /** После обрыва Realtime: перечитать последние сообщения всех открытых переписок */
  refreshLoaded: () => Promise<void>;
  edit: (messageId: string, content: string) => Promise<void>;
  remove: (message: Message) => Promise<void>;
  toggleReaction: (message: Message, emoji: string) => Promise<void>;
  fetchExtra: (id: string) => Promise<void>;
  applyRemote: (msg: Message) => void;
  reset: () => void;
}

const scopeKey = (m: Pick<Message, 'channel_id' | 'dm_id'>) => (m.channel_id ?? m.dm_id) as string;

function normalize(m: Message): Message {
  return {
    ...m,
    attachments: Array.isArray(m.attachments) ? m.attachments : [],
    reactions: m.reactions && typeof m.reactions === 'object' ? m.reactions : {},
    mentions: m.mentions ?? [],
  };
}

export const useMessages = create<MessagesState>((set, get) => {
  const patchScope = (id: string, patch: Partial<ScopeMessages>) =>
    set({ byScope: { ...get().byScope, [id]: { ...(get().byScope[id] ?? EMPTY), ...patch } } });

  const patchMessage = (scopeId: string, messageId: string, fn: (m: Message) => Message) => {
    const cur = get().byScope[scopeId];
    if (!cur) return;
    patchScope(scopeId, { messages: cur.messages.map((m) => (m.id === messageId ? fn(m) : m)) });
  };

  const findLocal = (scopeId: string, messageId: string) => get().byScope[scopeId]?.messages.find((m) => m.id === messageId);

  const query = (scope: Scope) => {
    const q = supabase.from('messages').select('*').order('created_at', { ascending: false }).limit(PAGE);
    return scope.kind === 'channel' ? q.eq('channel_id', scope.id) : q.eq('dm_id', scope.id);
  };

  const outgoing = createOutgoingMessages({
    find: findLocal,
    patch: patchMessage,
    append: (scopeId, message) => {
      const messages = get().byScope[scopeId]?.messages ?? [];
      patchScope(scopeId, { messages: [...messages, message] });
    },
    remove: (scopeId, id) => {
      const cur = get().byScope[scopeId];
      if (cur) patchScope(scopeId, { messages: cur.messages.filter((m) => m.id !== id) });
    },
    applyRemote: (message) => get().applyRemote(message),
  });

  function mergeReceived(existing: Message[], incoming: Message[]): Message[] {
    const map = new Map(existing.map((m) => [m.id, m]));
    for (const m of incoming) {
      if (!m._status) outgoing.confirm(m.id);
      const prev = map.get(m.id);
      map.set(m.id, prev && !m._status ? { ...prev, ...m, _status: undefined, _error: undefined } : m);
    }
    return [...map.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  return {
    byScope: {},
    extra: {},

    ...outgoing.actions,
    reset: () => {
      outgoing.reset();
      set({ byScope: {}, extra: {} });
    },

    load: async (scope) => {
      const cur = get().byScope[scope.id];
      if (cur?.loading || cur?.loaded) return;
      patchScope(scope.id, { loading: true, error: null });
      const { data, error } = await query(scope);
      if (error) {
        patchScope(scope.id, { loading: false, error: errorMessage(error) });
        return;
      }
      const rows = ((data ?? []) as Message[]).map(normalize).reverse();
      useProfiles.getState().ensure(rows.map((m) => m.author_id));
      const existing = get().byScope[scope.id]?.messages ?? [];
      patchScope(scope.id, {
        messages: mergeReceived(existing, rows),
        hasMore: rows.length === PAGE,
        loading: false,
        loaded: true,
      });
    },

    loadOlder: async (scope) => {
      const cur = get().byScope[scope.id];
      if (!cur || cur.loading || !cur.hasMore) return;
      const oldest = cur.messages.find((m) => !m._status);
      if (!oldest) return;
      patchScope(scope.id, { loading: true });
      const { data, error } = await query(scope).lt('created_at', oldest.created_at);
      if (error) {
        patchScope(scope.id, { loading: false, error: errorMessage(error) });
        return;
      }
      const rows = ((data ?? []) as Message[]).map(normalize).reverse();
      useProfiles.getState().ensure(rows.map((m) => m.author_id));
      patchScope(scope.id, {
        messages: mergeReceived(get().byScope[scope.id]?.messages ?? [], rows),
        hasMore: rows.length === PAGE,
        loading: false,
      });
    },

    refreshLoaded: async () => {
      const ids = Object.entries(get().byScope)
        .filter(([, s]) => s.loaded)
        .map(([id]) => id)
        .filter((id) => /^[0-9a-f-]{36}$/i.test(id));
      await Promise.allSettled(
        ids.map(async (id) => {
          const { data, error } = await supabase
            .from('messages')
            .select('*')
            .or(`channel_id.eq.${id},dm_id.eq.${id}`)
            .order('created_at', { ascending: false })
            .limit(PAGE);
          if (error || !data) return;
          const rows = (data as Message[]).map(normalize).reverse();
          useProfiles.getState().ensure(rows.map((m) => m.author_id));
          patchScope(id, { messages: mergeReceived(get().byScope[id]?.messages ?? [], rows) });
        }),
      );
    },

    edit: async (messageId, content) => {
      const { error } = await supabase.rpc('edit_message', { p_message: messageId, p_content: content });
      if (error) throw new Error(errorMessage(error));
    },

    remove: async (message) => {
      const uid = useAuth.getState().userId;
      const paths = message.attachments.map((a) => a.path).filter(Boolean);
      const { error } = await supabase.rpc('delete_message', { p_message: message.id });
      if (error) throw new Error(errorMessage(error));
      // Файлы удаляются из Storage (Storage RLS разрешает автору и модераторам канала)
      if (paths.length && (message.author_id === uid || message.channel_id)) {
        void removeAttachments(paths).then(() => attachmentUsage(true)).catch(() => undefined);
      }
      get().applyRemote({ ...message, deleted_at: new Date().toISOString(), content: '', attachments: [], reactions: {} });
    },

    toggleReaction: async (message, emoji) => {
      const uid = useAuth.getState().userId;
      if (!uid) return;
      const mine = (message.reactions[emoji] ?? []).includes(uid);
      // Оптимистично
      const users = message.reactions[emoji] ?? [];
      const nextUsers = mine ? users.filter((u) => u !== uid) : [...users, uid];
      const reactions = { ...message.reactions };
      if (nextUsers.length) reactions[emoji] = nextUsers;
      else delete reactions[emoji];
      get().applyRemote({ ...message, reactions });
      const res = mine
        ? await supabase.from('message_reactions').delete().match({ message_id: message.id, user_id: uid, emoji })
        : await supabase.from('message_reactions').insert({ message_id: message.id, user_id: uid, emoji });
      if (res.error) {
        get().applyRemote(message);
        throw new Error(errorMessage(res.error));
      }
    },

    fetchExtra: async (id) => {
      if (get().extra[id]) return;
      const { data } = await supabase.from('messages').select('*').eq('id', id).maybeSingle();
      if (data) {
        useProfiles.getState().ensure([(data as Message).author_id]);
        set({ extra: { ...get().extra, [id]: normalize(data as Message) } });
      }
    },

    applyRemote: (raw) => {
      const msg = normalize(raw);
      const key = scopeKey(msg);
      const cur = get().byScope[key];
      if (get().extra[msg.id]) set({ extra: { ...get().extra, [msg.id]: msg } });
      if (!cur) return; // переписка не открыта — сообщение загрузится при открытии
      useProfiles.getState().ensure([msg.author_id]);
      patchScope(key, { messages: mergeReceived(cur.messages, [msg]) });
    },
  };
});

export function findMessage(scopeId: string, id: string): Message | undefined {
  const s = useMessages.getState();
  return s.byScope[scopeId]?.messages.find((m) => m.id === id) ?? s.extra[id];
}
