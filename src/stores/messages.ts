import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { errorMessage } from '@/lib/errors';
import {
  accessToken, attachmentUsage, imageSize, maxAttachmentBytes, publishableKey, removeAttachments, reserveAttachment, tusEndpoint, uploadBlob,
} from '@/lib/media';
import { formatSize } from '@/lib/format';
import type { Attachment, Message, OutgoingItem, Scope } from '@/lib/types';
import { useAuth } from './auth';
import { useProfiles } from './profiles';
import { useTransfers } from './transfers';
import { toast } from './ui';

const PAGE = 50;

export interface ScopeMessages {
  messages: Message[]; // по возрастанию created_at
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

const EMPTY: ScopeMessages = { messages: [], hasMore: true, loading: false, loaded: false, error: null };

interface MessagesState {
  byScope: Record<string, ScopeMessages>;
  extra: Record<string, Message>; // сообщения, на которые отвечают, но которые не загружены
  load: (scope: Scope) => Promise<void>;
  loadOlder: (scope: Scope) => Promise<void>;
  send: (scope: Scope, content: string, items: OutgoingItem[], replyTo: string | null, kind?: 'default' | 'call') => Promise<void>;
  retry: (scope: Scope, messageId: string) => Promise<void>;
  discard: (scope: Scope, messageId: string) => void;
  pauseUpload: (uploadId: string) => Promise<void>;
  resumeUpload: (uploadId: string) => Promise<void>;
  cancelUpload: (uploadId: string) => Promise<void>;
  edit: (messageId: string, content: string) => Promise<void>;
  remove: (message: Message) => Promise<void>;
  toggleReaction: (message: Message, emoji: string) => Promise<void>;
  fetchExtra: (id: string) => Promise<void>;
  applyRemote: (msg: Message) => void;
  reset: () => void;
}

const scopeKey = (m: Pick<Message, 'channel_id' | 'dm_id'>) => (m.channel_id ?? m.dm_id) as string;

// ---------- Отправка вложений ----------

interface ItemTask {
  id: string;
  item: OutgoingItem;
  prepared?: { size: number; contentType: string };
  path?: string;
  attachment?: Attachment;
  cancelled?: boolean;
}

interface OutgoingMessage {
  scope: Scope;
  messageId: string;
  tasks: ItemTask[];
  running: boolean;
}

const outgoing = new Map<string, OutgoingMessage>();
const taskIndex = new Map<string, string>(); // uploadId -> messageId

class PausedError extends Error {}
class CancelledError extends Error {}

/** Ошибки IPC приходят как «Error invoking remote method 'x': Error: текст» */
function cleanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

function normalize(m: Message): Message {
  return {
    ...m,
    attachments: Array.isArray(m.attachments) ? m.attachments : [],
    reactions: m.reactions && typeof m.reactions === 'object' ? m.reactions : {},
    mentions: m.mentions ?? [],
  };
}

function mergeSorted(existing: Message[], incoming: Message[]): Message[] {
  const map = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) {
    const prev = map.get(m.id);
    map.set(m.id, prev && !m._status ? { ...prev, ...m, _status: undefined, _error: undefined } : m);
  }
  return [...map.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
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

  /** Подготовить, зарезервировать и загрузить одно вложение. Повторный вызов продолжает с места остановки. */
  const uploadItem = async (scope: Scope, uid: string, t: ItemTask): Promise<Attachment> => {
    if (t.attachment) return t.attachment;
    const tr = useTransfers.getState();
    const it = t.item;
    const max = await maxAttachmentBytes();

    if (!t.prepared) {
      if (it.token) {
        if (!window.rv?.files) throw new Error('Отправка файлов доступна только в приложении');
        tr.setUpload(t.id, { phase: 'preparing', error: null });
        t.prepared = await window.rv.files.prepare(t.id, it.token, max);
      } else if (it.blob) {
        t.prepared = { size: it.blob.size, contentType: it.blob.type || 'application/octet-stream' };
      } else {
        throw new Error('Файл недоступен — прикрепите его снова');
      }
    }
    const size = t.prepared.size;
    if (size > max) throw new Error(`«${it.name}» — ${formatSize(size)}. Можно отправить до ${formatSize(max)} (лимит бесплатного хранилища)`);
    if (t.cancelled) throw new CancelledError();

    if (!t.path) {
      tr.setUpload(t.id, { phase: 'reserving', total: size, error: null });
      const uploadName = it.kind === 'folder' ? `${it.name}.zip` : it.name;
      t.path = (await reserveAttachment(scope, uid, uploadName, size)).path;
    }
    if (t.cancelled) throw new CancelledError();

    tr.setUpload(t.id, { phase: 'uploading', total: size, error: null });
    if (it.token) {
      try {
        await window.rv!.files.upload({
          id: t.id,
          token: it.token,
          endpoint: tusEndpoint(),
          bucket: 'attachments',
          objectPath: t.path,
          contentType: t.prepared.contentType,
          accessToken: await accessToken(),
          apiKey: publishableKey(),
          maxBytes: max,
        });
      } catch (e) {
        const msg = cleanError(e);
        if (msg === 'paused') throw new PausedError();
        if (msg === 'cancelled' || t.cancelled) throw new CancelledError();
        throw new Error(msg);
      }
    } else {
      await uploadBlob(t.path, it.blob!, t.prepared.contentType);
    }
    const dims = it.previewFile ? await imageSize(it.previewFile) : it.blob ? await imageSize(it.blob) : null;
    t.attachment = {
      path: t.path,
      name: it.name.slice(0, 200),
      size,
      mime: it.kind === 'folder' ? 'application/zip' : t.prepared.contentType,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      kind: it.kind,
      folder: it.kind === 'folder' ? { files: it.files ?? 0, dirs: it.dirs ?? 0, bytes: it.size } : null,
    };
    tr.setUpload(t.id, { phase: 'done', transferred: size, total: size });
    return t.attachment;
  };

  const insertRow = async (scope: Scope, msg: Message, attachments: Attachment[]) => {
    const uid = useAuth.getState().userId!;
    const { data, error } = await supabase
      .from('messages')
      .insert({
        id: msg.id,
        channel_id: scope.kind === 'channel' ? scope.id : null,
        dm_id: scope.kind === 'dm' ? scope.id : null,
        author_id: uid,
        kind: msg.kind,
        content: msg.content,
        reply_to_id: msg.reply_to_id,
        attachments,
      })
      .select('*')
      .single();
    if (error) throw new Error(errorMessage(error));
    get().applyRemote(data as Message);
  };

  const finishOutgoing = (o: OutgoingMessage) => {
    outgoing.delete(o.messageId);
    for (const t of o.tasks) {
      taskIndex.delete(t.id);
      useTransfers.getState().removeUpload(t.id);
    }
    const tokens = o.tasks.map((t) => t.item.token).filter((x): x is string => !!x);
    if (tokens.length) void window.rv?.files.release(tokens);
  };

  /** Конвейер сообщения: загрузить все вложения по очереди, затем создать сообщение */
  const runMessage = async (messageId: string): Promise<void> => {
    const o = outgoing.get(messageId);
    if (!o || o.running) return;
    const msg = findLocal(o.scope.id, messageId);
    if (!msg) {
      finishOutgoing(o);
      return;
    }
    o.running = true;
    patchMessage(o.scope.id, messageId, (m) => ({ ...m, _status: 'sending', _error: undefined }));
    const uid = useAuth.getState().userId!;
    const done: Attachment[] = [];
    try {
      for (const t of o.tasks) {
        if (t.cancelled) continue;
        done.push(await uploadItem(o.scope, uid, t));
      }
      const live = o.tasks.filter((t) => !t.cancelled);
      const current = findLocal(o.scope.id, messageId);
      if (!current) return;
      if (live.length === 0 && !current.content && current.kind === 'default') {
        // Всё отменено и текста нет — сообщение не нужно
        get().discard(o.scope, messageId);
        return;
      }
      await insertRow(o.scope, current, done);
      const sentFiles = live.length;
      finishOutgoing(o);
      if (sentFiles > 0) {
        toast.success(sentFiles === 1 ? 'Файл отправлен' : `Отправлено вложений: ${sentFiles}`, live.map((t) => t.item.name).join(', ').slice(0, 120));
      }
    } catch (e) {
      if (e instanceof PausedError) return;
      if (e instanceof CancelledError) {
        o.running = false;
        void runMessage(messageId);
        return;
      }
      const text = cleanError(e);
      patchMessage(o.scope.id, messageId, (m) => ({ ...m, _status: 'failed', _error: text }));
      for (const t of o.tasks) {
        if (!t.attachment && !t.cancelled) useTransfers.getState().setUpload(t.id, { phase: 'error', error: text });
      }
      toast.error(o.tasks.length ? 'Не удалось отправить вложение' : 'Сообщение не отправлено', text);
      throw new Error(text);
    } finally {
      const still = outgoing.get(messageId);
      if (still) still.running = false;
    }
  };

  return {
    byScope: {},
    extra: {},

    reset: () => set({ byScope: {}, extra: {} }),

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
        messages: mergeSorted(existing, rows),
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
        messages: mergeSorted(get().byScope[scope.id]?.messages ?? [], rows),
        hasMore: rows.length === PAGE,
        loading: false,
      });
    },

    send: async (scope, content, items, replyTo, kind = 'default') => {
      const uid = useAuth.getState().userId;
      if (!uid) return;
      const text = content.replace(/\s+$/, '');
      if (!text && items.length === 0 && kind === 'default') return;
      if (text.length > 4000) throw new Error('Сообщение длиннее 4000 символов');
      const id = crypto.randomUUID();
      const tasks: ItemTask[] = items.map((item) => ({ id: crypto.randomUUID(), item }));
      const msg: Message = {
        id,
        channel_id: scope.kind === 'channel' ? scope.id : null,
        dm_id: scope.kind === 'dm' ? scope.id : null,
        author_id: uid,
        kind,
        content: text,
        reply_to_id: replyTo,
        attachments: tasks.map((t) => ({
          path: '',
          name: t.item.name,
          size: t.item.size,
          mime: t.item.mime ?? '',
          kind: t.item.kind,
          _uploadId: t.id,
        })),
        mentions: [],
        mention_everyone: false,
        reactions: {},
        edited_at: null,
        deleted_at: null,
        created_at: new Date().toISOString(),
        _status: 'sending',
      };
      for (const t of tasks) {
        taskIndex.set(t.id, id);
        useTransfers.getState().setUpload(t.id, {
          messageId: id, name: t.item.name, kind: t.item.kind, phase: 'queued', transferred: 0, total: t.item.size, bytesPerSecond: 0,
        });
      }
      outgoing.set(id, { scope, messageId: id, tasks, running: false });
      const cur = get().byScope[scope.id] ?? { ...EMPTY, loaded: true };
      patchScope(scope.id, { messages: [...cur.messages, msg] });
      await runMessage(id);
    },

    retry: async (scope, messageId) => {
      if (!outgoing.has(messageId)) {
        // Текстовое сообщение без вложений
        const msg = findLocal(scope.id, messageId);
        if (!msg) return;
        outgoing.set(messageId, { scope, messageId, tasks: [], running: false });
      }
      await runMessage(messageId);
    },

    discard: (scope, messageId) => {
      const o = outgoing.get(messageId);
      if (o) {
        for (const t of o.tasks) {
          t.cancelled = true;
          if (t.item.token) void window.rv?.files.cancel(t.id);
        }
        const uploaded = o.tasks.map((t) => t.attachment?.path).filter((p): p is string => !!p);
        if (uploaded.length) void removeAttachments(uploaded).catch(() => undefined);
        finishOutgoing(o);
      }
      const cur = get().byScope[scope.id];
      if (cur) patchScope(scope.id, { messages: cur.messages.filter((m) => m.id !== messageId) });
    },

    pauseUpload: async (uploadId) => {
      await window.rv?.files.pause(uploadId);
    },

    resumeUpload: async (uploadId) => {
      const messageId = taskIndex.get(uploadId);
      if (!messageId) return;
      useTransfers.getState().setUpload(uploadId, { phase: 'uploading', error: null });
      await runMessage(messageId).catch(() => undefined);
    },

    cancelUpload: async (uploadId) => {
      const messageId = taskIndex.get(uploadId);
      const o = messageId ? outgoing.get(messageId) : undefined;
      if (!o || !messageId) return;
      const t = o.tasks.find((x) => x.id === uploadId);
      if (!t) return;
      t.cancelled = true;
      if (t.item.token) await window.rv?.files.cancel(uploadId);
      if (t.attachment?.path) void removeAttachments([t.attachment.path]).catch(() => undefined);
      taskIndex.delete(uploadId);
      useTransfers.getState().removeUpload(uploadId);
      patchMessage(o.scope.id, messageId, (m) => ({ ...m, attachments: m.attachments.filter((a) => a._uploadId !== uploadId) }));
      if (!o.running) {
        const m = findLocal(o.scope.id, messageId);
        if (m && m._status === 'failed') return; // пользователь сам нажмёт «Повторить»
        void runMessage(messageId).catch(() => undefined);
      }
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
      patchScope(key, { messages: mergeSorted(cur.messages, [msg]) });
    },
  };
});

export function findMessage(scopeId: string, id: string): Message | undefined {
  const s = useMessages.getState();
  return s.byScope[scopeId]?.messages.find((m) => m.id === id) ?? s.extra[id];
}
