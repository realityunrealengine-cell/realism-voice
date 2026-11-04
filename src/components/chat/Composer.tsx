import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Paperclip, Send, Smile, X } from 'lucide-react';
import type { Profile, Scope } from '@/lib/types';
import { useMessages, findMessage } from '@/stores/messages';
import { useProfile, useProfiles } from '@/stores/profiles';
import { useServers } from '@/stores/servers';
import { useAuth } from '@/stores/auth';
import { toast, useUi } from '@/stores/ui';
import { MAX_ATTACHMENT } from '@/lib/media';
import { formatSize } from '@/lib/format';
import { Avatar } from '@/components/ui/Avatar';
import { EmojiPicker } from './EmojiPicker';
import { lastOwnEditable } from './MessageItem';

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

function FilePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => (file.type.startsWith('image/') ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  return (
    <div className="relative w-36 shrink-0 rounded-xl border border-white/10 bg-black/30 p-2">
      <button onClick={onRemove} className="absolute -right-2 -top-2 rounded-full bg-rose-500 p-0.5 text-white shadow" title="Убрать">
        <X className="h-3.5 w-3.5" />
      </button>
      <div className="flex h-20 items-center justify-center overflow-hidden rounded-lg bg-black/30">
        {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <FileText className="h-8 w-8 text-indigo-300" />}
      </div>
      <div className="mt-1 truncate text-xs text-slate-300">{file.name}</div>
      <div className="text-[10px] text-slate-500">{formatSize(file.size)}</div>
    </div>
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
  const [files, setFiles] = useState<File[]>([]);
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

  const addFiles = (list: FileList | File[]) => {
    const arr = [...list];
    const big = arr.find((f) => f.size > MAX_ATTACHMENT);
    if (big) toast.error('Файл слишком большой', `«${big.name}» больше 25 МБ`);
    setFiles((prev) => [...prev, ...arr.filter((f) => f.size <= MAX_ATTACHMENT)].slice(0, 10));
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
    try {
      await useMessages.getState().send(scope, content, toSend, replyTo);
    } catch (e) {
      toast.error('Сообщение не отправлено', (e as Error).message);
    }
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
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-x-4 bottom-5 top-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-[color:var(--a2)] bg-black/60 text-sm text-white">
          Отпустите, чтобы прикрепить файлы
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
          {files.map((f, i) => (
            <FilePreview key={`${f.name}-${i}`} file={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-white/5 bg-black/35 px-3 py-2 focus-within:border-white/15">
        <button className="icon-btn mb-0.5" title="Прикрепить файл" onClick={() => fileRef.current?.click()}>
          <Paperclip className="h-5 w-5" />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
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
              addFiles(e.clipboardData.files);
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
