import { errorMessage } from '@/lib/errors';
import { formatSize } from '@/lib/format';
import {
  accessToken, imageSize, maxAttachmentBytes, publishableKey, removeAttachments, reserveAttachment, tusEndpoint, uploadBlob,
} from '@/lib/media';
import { supabase } from '@/lib/supabase';
import type { Attachment, Message, OutgoingItem, Scope } from '@/lib/types';
import { useAuth } from './auth';
import { useTransfers } from './transfers';
import { toast } from './ui';

export interface OutgoingActions {
  send: (scope: Scope, content: string, items: OutgoingItem[], replyTo: string | null, kind?: 'default' | 'call') => Promise<void>;
  retry: (scope: Scope, messageId: string) => Promise<void>;
  discard: (scope: Scope, messageId: string) => void;
  pauseUpload: (uploadId: string) => Promise<void>;
  resumeUpload: (uploadId: string) => Promise<void>;
  cancelUpload: (uploadId: string) => Promise<void>;
}

interface MessageHistory {
  find(scopeId: string, id: string): Message | undefined;
  append(scopeId: string, message: Message): void;
  patch(scopeId: string, id: string, update: (message: Message) => Message): void;
  remove(scopeId: string, id: string): void;
  applyRemote(message: Message): void;
}

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
  inserting?: boolean;
  submitted?: boolean;
}

class PausedError extends Error {}

/** Ошибки IPC приходят как «Error invoking remote method 'x': Error: текст» */
function cleanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

export function createOutgoingMessages(history: MessageHistory) {
  const outgoing = new Map<string, OutgoingMessage>();
  const taskIndex = new Map<string, string>(); // uploadId -> messageId

  /** Подготовить, зарезервировать и загрузить одно вложение. Повторный вызов продолжает с места остановки. */
  const uploadItem = async (scope: Scope, uid: string, t: ItemTask): Promise<void> => {
    if (t.attachment) return;
    const tr = useTransfers.getState();
    const it = t.item;
    const max = await maxAttachmentBytes();

    if (t.cancelled) return;

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
    if (t.cancelled) return;

    if (!t.path) {
      tr.setUpload(t.id, { phase: 'reserving', total: size, error: null });
      const uploadName = it.kind === 'folder' ? `${it.name}.zip` : it.name;
      t.path = (await reserveAttachment(scope, uid, uploadName, size)).path;
    }
    if (t.cancelled) return;

    tr.setUpload(t.id, { phase: 'uploading', total: size, error: null });
    if (it.token) {
      try {
        const token = await accessToken();
        if (t.cancelled) return;
        await window.rv!.files.upload({
          id: t.id,
          token: it.token,
          endpoint: tusEndpoint(),
          bucket: 'attachments',
          objectPath: t.path,
          contentType: t.prepared.contentType,
          accessToken: token,
          apiKey: publishableKey(),
          maxBytes: max,
        });
      } catch (e) {
        const msg = cleanError(e);
        if (msg === 'paused') throw new PausedError();
        if (msg === 'cancelled') {
          t.cancelled = true;
          return;
        }
        throw new Error(msg);
      }
    } else {
      await uploadBlob(t.path, it.blob!, t.prepared.contentType);
    }
    const dims = it.previewFile ? await imageSize(it.previewFile) : it.blob ? await imageSize(it.blob) : null;
    if (t.cancelled) {
      if (useAuth.getState().userId === uid) void removeAttachments([t.path]).catch(() => undefined);
      return;
    }
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
  };

  const insertRow = async (scope: Scope, msg: Message, attachments: Attachment[]) => {
    let result = await supabase
      .from('messages')
      .insert({
        id: msg.id,
        channel_id: scope.kind === 'channel' ? scope.id : null,
        dm_id: scope.kind === 'dm' ? scope.id : null,
        author_id: msg.author_id,
        kind: msg.kind,
        content: msg.content,
        reply_to_id: msg.reply_to_id,
        attachments,
      })
      .select('*')
      .single();
    if (!outgoing.has(msg.id)) return;
    if (result.error?.code === '23505') {
      // A previous attempt can commit even if its response never arrives.
      result = await supabase.from('messages').select('*').eq('id', msg.id).single();
    }
    if (result.error) throw new Error(errorMessage(result.error));
    if (outgoing.has(msg.id)) history.applyRemote(result.data as Message);
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
    const msg = history.find(o.scope.id, messageId);
    if (!msg) {
      finishOutgoing(o);
      return;
    }
    o.running = true;
    history.patch(o.scope.id, messageId, (m) => ({ ...m, _status: 'sending', _error: undefined }));

    try {
      for (const t of o.tasks) {
        if (t.cancelled) continue;
        try {
          await uploadItem(o.scope, msg.author_id, t);
        } catch (error) {
          if (!t.cancelled) throw error;
        }
      }
      const live = o.tasks.filter((t) => !t.cancelled);
      const current = history.find(o.scope.id, messageId);
      if (!current || !outgoing.has(messageId)) return;
      if (live.length === 0 && !current.content && current.kind === 'default') {
        // Всё отменено и текста нет — сообщение не нужно
        actions.discard(o.scope, messageId);
        return;
      }
      o.inserting = true;
      o.submitted = true;
      await insertRow(o.scope, current, live.map((task) => task.attachment!));
    } catch (e) {
      if (!outgoing.has(messageId)) return;
      if (e instanceof PausedError) return;
      const text = cleanError(e);
      history.patch(o.scope.id, messageId, (m) => ({ ...m, _status: 'failed', _error: text }));
      for (const t of o.tasks) {
        if (!t.attachment && !t.cancelled) useTransfers.getState().setUpload(t.id, { phase: 'error', error: text });
      }
      toast.error(o.tasks.length ? 'Не удалось отправить вложение' : 'Сообщение не отправлено', text);
      throw new Error(text);
    } finally {
      o.running = false;
      o.inserting = false;
    }
  };

  const actions: OutgoingActions = {
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
      history.append(scope.id, msg);
      await runMessage(id);
    },

    retry: async (scope, messageId) => {
      if (!outgoing.has(messageId)) {
        // Текстовое сообщение без вложений
        const msg = history.find(scope.id, messageId);
        if (msg?._status !== 'failed') return;
        outgoing.set(messageId, { scope, messageId, tasks: [], running: false });
      }
      await runMessage(messageId);
    },

    discard: (scope, messageId) => {
      const o = outgoing.get(messageId);
      if (o?.inserting) return;
      if (o) {
        for (const t of o.tasks) {
          t.cancelled = true;
          if (t.item.token) void window.rv?.files.cancel(t.id);
        }
        const uploaded = o.tasks.map((t) => t.attachment?.path).filter((p): p is string => !!p);
        // After INSERT, only server-side stale-upload cleanup can establish that a file is unreferenced.
        if (!o.submitted && uploaded.length) void removeAttachments(uploaded).catch(() => undefined);
        finishOutgoing(o);
      }
      history.remove(scope.id, messageId);
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
      if (!o || !messageId || o.inserting) return;
      const t = o.tasks.find((x) => x.id === uploadId);
      if (!t) return;
      t.cancelled = true;
      if (t.item.token) await window.rv?.files.cancel(uploadId);
      if (!o.submitted && t.attachment?.path) void removeAttachments([t.attachment.path]).catch(() => undefined);
      taskIndex.delete(uploadId);
      useTransfers.getState().removeUpload(uploadId);
      history.patch(o.scope.id, messageId, (m) => ({ ...m, attachments: m.attachments.filter((a) => a._uploadId !== uploadId) }));
      if (!o.running) {
        const m = history.find(o.scope.id, messageId);
        if (m && m._status === 'failed') return; // пользователь сам нажмёт «Повторить»
        void runMessage(messageId).catch(() => undefined);
      }
    },
  };

  function confirm(messageId: string) {
    const message = outgoing.get(messageId);
    if (!message) return;
    const files = message.tasks.filter((task) => !task.cancelled);
    finishOutgoing(message);
    if (files.length) {
      const title = files.length === 1 ? 'Файл отправлен' : `Отправлено вложений: ${files.length}`;
      toast.success(title, files.map((task) => task.item.name).join(', ').slice(0, 120));
    }
  }

  function reset() {
    for (const message of outgoing.values()) {
      for (const task of message.tasks) {
        task.cancelled = true;
        if (task.item.token) void window.rv?.files.cancel(task.id);
      }
      finishOutgoing(message);
    }
  }

  return { actions, confirm, reset };
}
