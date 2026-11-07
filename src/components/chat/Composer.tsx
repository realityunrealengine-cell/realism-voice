import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FileText, Folder, FolderUp, FileUp, Plus, Send, ShieldAlert, Smile, X } from 'lucide-react';
import type { OutgoingItem, Profile, Scope } from '@/lib/types';
import type { PickedItem } from '../../../electron/shared';
import { isDangerousFile } from '../../../electron/fileRisk';
import { useMessages, findMessage } from '@/stores/messages';
import { useProfile, useProfiles } from '@/stores/profiles';
import { useServers } from '@/stores/servers';
import { useAuth } from '@/stores/auth';
import { toast, useUi } from '@/stores/ui';
import { FREE_MAX_ATTACHMENT, MAX_ATTACHMENTS_PER_MESSAGE, maxAttachmentBytes } from '@/lib/media';
import { formatSize, plural } from '@/lib/format';
import { Avatar } from '@/components/ui/Avatar';
import { EmojiPicker } from './EmojiPicker';
import { lastOwnEditable } from './MessageItem';

/** Исходный объём папки до сжатия (ограничение main-процесса) */
const MAX_FOLDER_SOURCE = 1024 * 1024 * 1024;

function tooBigText(name: string, size: number, max: number): string {
  return `«${name}» — ${formatSize(size)}. Бесплатное хранилище Realism Voice принимает файлы до ${formatSize(max)}. Для больших файлов отправьте ссылку на облачный диск.`;
}

interface Props {
  scope: Scope;
  serverId: string | null;
  placeholder: string;
  disabled?: string | null;
  onTyping: () => void;
  onStopTyping: () => void;
  mentionCandidates: string[];
}

const drafts = new Map<string, string>();

function FilePreview({ item, onRemove }: { item: OutgoingItem; onRemove: () => void }) {
  const src = item.previewFile ?? item.blob;
  const url = useMemo(() => (src && src.type.startsWith('image/') ? URL.createObjectURL(src) : null), [src]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  const dangerous = item.kind === 'file' && isDangerousFile(item.name);
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      className="relative w-36 shrink-0 rounded-xl border border-white/10 bg-black/30 p-2"
    >
      <button onClick={onRemove} className="absolute -right-2 -top-2 rounded-full bg-rose-500 p-0.5 text-white shadow" title="Убрать">
        <X className="h-3.5 w-3.5" />
      </button>
      <div className="flex h-20 items-center justify-center overflow-hidden rounded-lg bg-black/30">
        {url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : item.kind === 'folder' ? (
          <Folder className="h-8 w-8 text-amber-300" />
        ) : dangerous ? (
          <ShieldAlert className="h-8 w-8 text-rose-300" />
        ) : (
          <FileText className="h-8 w-8 text-indigo-300" />
        )}
      </div>
      <div className="mt-1 truncate text-xs text-slate-300" title={item.name}>
        {item.name}
      </div>
      <div className="truncate text-[10px] text-slate-500">
        {item.kind === 'folder'
          ? `${item.files ?? 0} ${plural(item.files ?? 0, 'файл', 'файла', 'файлов')} · ${formatSize(item.size)} → ZIP`
          : formatSize(item.size)}
      </div>
    </motion.div>
  );
}

function AttachMenu({ onFile, onFolder, onClose, maxFile }: { onFile: () => void; onFolder: () => void; onClose: () => void; maxFile: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => window.addEventListener('mousedown', down), 0);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const item = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-slate-200 hover:bg-white/10 [&>svg]:h-4 [&>svg]:w-4';
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.98 }}
      transition={{ duration: 0.12 }}
      className="glass-strong absolute bottom-12 left-0 z-30 w-60 rounded-xl p-1.5 shadow-glass"
    >
      <button className={item} onClick={onFile}>
        <FileUp /> Отправить файл
      </button>
      <button className={item} onClick={onFolder}>
        <FolderUp /> Отправить папку
      </button>
      <div className="mt-1 border-t border-white/5 px-2.5 pb-1 pt-2 text-[11px] leading-snug text-slate-500">
        До {formatSize(maxFile)} на файл · папка сжимается в ZIP · до {MAX_ATTACHMENTS_PER_MESSAGE} вложений
      </div>
    </motion.div>
  );
}

function ReplyBar({ scope }: { scope: Scope }) {
  const replyId = useUi((s) => s.replyTo[scope.id]);
  const msg = replyId ? findMessage(scope.id, replyId) : undefined;
  const author = useProfile(msg?.author_id);
  if (!replyId || !msg) return null;
  return (
    <div className="flex items-center justify-between rounded-t-xl bg-black/30 px-4 py-2 text-sm text-slate-400">
      <span className="truncate">
        Ответ <span className="font-semibold text-slate-200">{author?.display_name ?? '…'}</span>: {msg.content.slice(0, 80) || 'Вложение'}
      </span>
      <button className="icon-btn h-6 w-6" onClick={() => useUi.getState().setReplyTo(scope.id, null)}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function Composer({ scope, serverId, placeholder, disabled, onTyping, onStopTyping, mentionCandidates }: Props) {
  const [text, setText] = useState(() => drafts.get(scope.id) ?? '');
  const [files, setFiles] = useState<OutgoingItem[]>([]);
  const [menu, setMenu] = useState(false);
  const [maxFile, setMaxFile] = useState(FREE_MAX_ATTACHMENT);
  const [emoji, setEmoji] = useState(false);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const me = useAuth((s) => s.userId)!;
  const profiles = useProfiles((s) => s.byId);
  const members = useServers((s) => (serverId ? s.members[serverId] : undefined));

  useEffect(() => {
    drafts.set(scope.id, text);
  }, [scope.id, text]);

  useEffect(() => {
    ref.current?.focus();
  }, [scope.id]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const suggestions: Profile[] = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const ids = serverId ? (members ?? []).map((m) => m.user_id) : mentionCandidates;
    return ids
      .map((id) => profiles[id])
      .filter((p): p is Profile => !!p && (p.username.startsWith(q) || p.display_name.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [mention, members, profiles, serverId, mentionCandidates]);

  useEffect(() => {
    void maxAttachmentBytes().then(setMaxFile);
  }, [scope.id]);

  /** Проверка до загрузки: размер, пустые файлы, число вложений */
  const accept = (incoming: OutgoingItem[]) => {
    const ok: OutgoingItem[] = [];
    const rejected: string[] = [];
    for (const it of incoming) {
      if (it.kind === 'file' && it.size > maxFile) {
        toast.error('Файл слишком большой', tooBigText(it.name, it.size, maxFile));
        if (it.token) rejected.push(it.token);
        continue;
      }
      if (it.kind === 'folder' && it.size > MAX_FOLDER_SOURCE) {
        toast.error('Папка слишком большая', `«${it.name}» — ${formatSize(it.size)} до сжатия. Можно отправить папку, которая после сжатия в ZIP уложится в ${formatSize(maxFile)}.`);
        if (it.token) rejected.push(it.token);
        continue;
      }
      ok.push(it);
    }
    setFiles((prev) => {
      const next = [...prev, ...ok];
      if (next.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        toast.info('Слишком много вложений', `В одном сообщении — до ${MAX_ATTACHMENTS_PER_MESSAGE}. Остальные отправьте следующим сообщением.`);
        for (const extra of next.slice(MAX_ATTACHMENTS_PER_MESSAGE)) if (extra.token) rejected.push(extra.token);
      }
      return next.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
    });
    if (rejected.length) void window.rv?.files.release(rejected);
  };

  const fromPicked = (list: PickedItem[], previews: File[] = []) => {
    const out: OutgoingItem[] = [];
    for (const p of list) {
      if (p.error) {
        toast.error(p.kind === 'folder' ? 'Папку нельзя отправить' : 'Файл нельзя отправить', `«${p.name}»: ${p.error}`);
        void window.rv?.files.release([p.token]);
        continue;
      }
      out.push({
        key: p.token,
        token: p.token,
        name: p.name,
        size: p.size,
        kind: p.kind,
        files: p.files,
        dirs: p.dirs,
        previewFile: previews.find((f) => f.name === p.name && f.size === p.size),
      });
    }
    accept(out);
  };

  const fromBlobs = (list: File[]) =>
    accept(list.map((f) => ({ key: crypto.randomUUID(), name: f.name || `image-${Date.now()}.png`, size: f.size, kind: 'file' as const, blob: f, mime: f.type })));

  /** Файлы и папки из перетаскивания или вставки: с диска — через main-процесс, иначе как данные */
  const addDropped = async (list: FileList | File[]) => {
    const arr = [...list];
    if (!arr.length) return;
    if (!window.rv?.files) {
      fromBlobs(arr);
      return;
    }
    const picked = await window.rv.files.registerDropped(arr);
    fromPicked(picked, arr);
    const registeredNames = new Set(picked.map((p) => p.name));
    // Данные без файла на диске (например, скриншот из буфера обмена)
    const blobs = arr.filter((f) => !registeredNames.has(f.name) && f.size > 0 && f.type);
    if (blobs.length) fromBlobs(blobs);
  };

  const pickFiles = async () => {
    setMenu(false);
    const picked = await window.rv?.files.pickFiles();
    if (picked?.length) fromPicked(picked);
  };

  const pickFolder = async () => {
    setMenu(false);
    const picked = await window.rv?.files.pickFolder();
    if (picked) fromPicked([picked]);
  };

  const removeItem = (key: string) => {
    setFiles((prev) => {
      const it = prev.find((x) => x.key === key);
      if (it?.token) void window.rv?.files.release([it.token]);
      return prev.filter((x) => x.key !== key);
    });
  };

  const send = async () => {
    const content = text;
    if (!content.trim() && files.length === 0) return;
    const replyTo = useUi.getState().replyTo[scope.id] ?? null;
    const toSend = files;
    setText('');
    setFiles([]);
    drafts.delete(scope.id);
    useUi.getState().setReplyTo(scope.id, null);
    onStopTyping();
    // Ошибки показывает хранилище сообщений (с кнопкой «Повторить» у сообщения)
    await useMessages.getState().send(scope, content, toSend, replyTo).catch(() => undefined);
  };

  const insertMention = (p: Profile) => {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(ref.current?.selectionStart ?? text.length);
    const next = `${before}@${p.username} ${after}`;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = before.length + p.username.length + 2;
      ref.current?.setSelectionRange(pos, pos);
      ref.current?.focus();
    });
  };

  const onChange = (v: string) => {
    setText(v);
    if (v.trim()) onTyping();
    const caret = ref.current?.selectionStart ?? v.length;
    const m = v.slice(0, caret).match(/(^|\s)@([A-Za-z0-9_.]{0,32})$/);
    if (m) {
      setMention({ query: m[2], start: caret - m[2].length - 1 });
      setMentionIdx(0);
    } else setMention(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && suggestions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(suggestions[mentionIdx]);
        return;
      }
      if (e.key === 'Escape') {
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    } else if (e.key === 'ArrowUp' && !text) {
      const last = lastOwnEditable(scope.id, me);
      if (last) {
        e.preventDefault();
        useUi.getState().setEditing(last.id);
      }
    } else if (e.key === 'Escape') {
      useUi.getState().setReplyTo(scope.id, null);
    }
  };

  if (disabled) {
    return (
      <div className="px-4 pb-5">
        <div className="rounded-xl bg-black/30 px-4 py-3 text-sm text-slate-500">{disabled}</div>
      </div>
    );
  }

  return (
    <div
      className="relative px-4 pb-5"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) void addDropped(e.dataTransfer.files);
      }}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-x-4 bottom-5 top-0 z-20 flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-[color:var(--a2)] bg-black/60 text-sm text-white">
          Отпустите, чтобы прикрепить файлы или папки
          <span className="text-xs text-slate-400">до {formatSize(maxFile)} на файл · папки сжимаются в ZIP</span>
        </div>
      )}
      {mention && suggestions.length > 0 && (
        <div className="glass-strong absolute bottom-full left-4 right-4 mb-2 rounded-xl p-1.5 shadow-glass">
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Участники</div>
          {suggestions.map((p, i) => (
            <button
              key={p.id}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(p);
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${i === mentionIdx ? 'bg-white/10' : 'hover:bg-white/5'}`}
            >
              <Avatar userId={p.id} size={22} />
              <span className="text-slate-100">{p.display_name}</span>
              <span className="text-slate-500">@{p.username}</span>
            </button>
          ))}
        </div>
      )}
      <ReplyBar scope={scope} />
      {files.length > 0 && (
        <div className="flex gap-3 overflow-x-auto bg-black/30 px-4 pb-2 pt-4">
          <AnimatePresence initial={false}>
            {files.map((f) => (
              <FilePreview key={f.key} item={f} onRemove={() => removeItem(f.key)} />
            ))}
          </AnimatePresence>
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-white/5 bg-black/35 px-3 py-2 focus-within:border-white/15">
        <div className="relative">
          <button
            className={`icon-btn mb-0.5 transition ${menu ? 'rotate-45 bg-white/10 text-white' : ''}`}
            title="Прикрепить файл или папку"
            onClick={() => (window.rv?.files ? setMenu(!menu) : fileRef.current?.click())}
          >
            <Plus className="h-5 w-5" />
          </button>
          <AnimatePresence>
            {menu && <AttachMenu maxFile={maxFile} onFile={() => void pickFiles()} onFolder={() => void pickFolder()} onClose={() => setMenu(false)} />}
          </AnimatePresence>
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void addDropped(e.target.files);
            e.target.value = '';
          }}
        />
        <textarea
          ref={ref}
          value={text}
          rows={1}
          maxLength={4000}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setMention(null), 150)}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              void addDropped(e.clipboardData.files);
            }
          }}
          className="max-h-[240px] min-h-[24px] flex-1 resize-none bg-transparent py-1.5 text-[0.95rem] text-slate-100 outline-none placeholder:text-slate-500"
        />
        {text.length > 3500 && <span className="mb-2 text-xs tabular-nums text-amber-300">{4000 - text.length}</span>}
        <div className="relative">
          <button className="icon-btn mb-0.5" title="Эмодзи" onClick={() => setEmoji(!emoji)}>
            <Smile className="h-5 w-5" />
          </button>
          {emoji && (
            <EmojiPicker
              className="absolute bottom-12 right-0"
              onClose={() => setEmoji(false)}
              onPick={(e) => {
                setText((t) => t + e);
                ref.current?.focus();
              }}
            />
          )}
        </div>
        <button
          className={`icon-btn mb-0.5 ${text.trim() || files.length ? 'accent-bg text-white hover:text-white' : ''}`}
          title="Отправить (Enter)"
          onClick={() => void send()}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
