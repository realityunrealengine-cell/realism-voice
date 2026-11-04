import { memo, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Copy, CornerUpLeft, Pencil, Phone, RotateCw, SmilePlus, Trash2, Hash } from 'lucide-react';
import type { Message, Scope } from '@/lib/types';
import { roleAtLeast, ROLE_RANK } from '@/lib/types';
import { useProfile, useProfiles } from '@/stores/profiles';
import { useAuth } from '@/stores/auth';
import { useMessages } from '@/stores/messages';
import { useServers } from '@/stores/servers';
import { toast, useUi } from '@/stores/ui';
import { formatFull, formatMessageStamp, formatTime, INVITE_LINK_RE } from '@/lib/format';
import { isEmojiOnly, renderMessage } from '@/lib/markdown';
import { QUICK_REACTIONS } from '@/lib/emoji';
import { Avatar } from '@/components/ui/Avatar';
import { UserBadge } from '@/components/ui/UserBadge';
import { Attachments } from './Attachments';
import { EmojiPicker } from './EmojiPicker';
import { InviteEmbed } from './InviteEmbed';
import { memberMenu } from '@/components/modals/memberMenu';
import { useSettings } from '@/stores/settings';

interface Props {
  message: Message;
  scope: Scope;
  serverId: string | null;
  grouped: boolean;
}

function ReplyPreview({ scopeId, id }: { scopeId: string; id: string }) {
  const msg = useMessages((s) => s.byScope[scopeId]?.messages.find((m) => m.id === id) ?? s.extra[id]);
  const author = useProfile(msg?.author_id);
  useEffect(() => {
    if (!msg) void useMessages.getState().fetchExtra(id);
  }, [msg, id]);
  return (
    <div
      className="mb-0.5 ml-[18px] flex cursor-pointer items-center gap-1.5 text-xs text-slate-400 before:mr-1 before:h-2.5 before:w-7 before:rounded-tl-md before:border-l-2 before:border-t-2 before:border-white/20 before:content-['']"
      onClick={() => document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
    >
      {msg ? (
        <>
          <Avatar userId={msg.author_id} size={16} />
          <span className="font-medium text-slate-300">{author?.display_name ?? '…'}</span>
          <span className="truncate">{msg.deleted_at ? 'Сообщение удалено' : msg.content || 'Вложение'}</span>
        </>
      ) : (
        <span className="italic">Исходное сообщение не найдено</span>
      )}
    </div>
  );
}

function EditBox({ message, onDone }: { message: Message; onDone: () => void }) {
  const [text, setText] = useState(message.content);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);
  const save = async () => {
    if (text.trim() === message.content.trim()) return onDone();
    try {
      await useMessages.getState().edit(message.id, text);
      onDone();
    } catch (e) {
      toast.error('Не удалось изменить', (e as Error).message);
    }
  };
  return (
    <div className="mt-1">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') onDone();
        }}
        rows={Math.min(8, text.split('\n').length)}
        maxLength={4000}
        className="input resize-none"
      />
      <div className="mt-1 text-xs text-slate-500">
        Escape — <button className="text-sky-300 hover:underline" onClick={onDone}>отмена</button> • Enter —{' '}
        <button className="text-sky-300 hover:underline" onClick={() => void save()}>сохранить</button>
      </div>
    </div>
  );
}

export const MessageItem = memo(function MessageItem({ message: m, scope, serverId, grouped }: Props) {
  const me = useAuth((s) => s.userId)!;
  const author = useProfile(m.author_id);
  const member = useServers((s) => (serverId ? s.members[serverId]?.find((x) => x.user_id === m.author_id) : undefined));
  const myRole = useServers((s) => (serverId ? s.myRoles[serverId] : undefined));
  const editing = useUi((s) => s.editing === m.id);
  const compact = useSettings((s) => s.prefs.appearance.compact);
  const [picker, setPicker] = useState(false);
  const mine = m.author_id === me;
  const mentioned = m.mentions.includes(me) || m.mention_everyone;
  const authorRank = member ? ROLE_RANK[member.role] : 0;
  const canDelete = mine || (serverId && roleAtLeast(myRole, 'moderator') && myRole && ROLE_RANK[myRole] > authorRank);
  const name = member?.nickname || author?.display_name || '…';
  const ui = useUi.getState();

  if (m.deleted_at) {
    return (
      <div id={`msg-${m.id}`} className={`px-4 ${grouped ? 'py-0.5' : 'pt-3'} pl-[72px] text-sm italic text-slate-600`}>
        Сообщение удалено
      </div>
    );
  }

  if (m.kind === 'call') {
    return (
      <div id={`msg-${m.id}`} className="flex items-center gap-3 px-4 py-2 pl-[30px] text-sm text-slate-400">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300">
          <Phone className="h-3.5 w-3.5" />
        </span>
        <span>
          <span className="font-medium text-slate-200">{author?.display_name ?? '…'}</span> начал(а) звонок
        </span>
        <span className="text-xs text-slate-600">{formatMessageStamp(m.created_at)}</span>
      </div>
    );
  }

  const ctx = {
    mentionLookup: (username: string) => {
      const p = Object.values(useProfiles.getState().byId).find((x) => x.username === username);
      return p && (m.mentions.includes(p.id) || p.id === me) ? { id: p.id, label: p.display_name } : null;
    },
    onMention: (id: string) => ui.openModal({ type: 'profile', userId: id, serverId: serverId ?? undefined }),
    onLink: (url: string) => {
      const inv = url.match(INVITE_LINK_RE);
      if (inv) ui.openModal({ type: 'joinServer', code: inv[1] });
      else void window.rv?.app.openExternal(url);
    },
  };

  const react = (emoji: string) => {
    setPicker(false);
    void useMessages.getState().toggleReaction(m, emoji).catch((e) => toast.error('Реакция', e.message));
  };

  const remove = () =>
    ui.openModal({
      type: 'confirm',
      title: 'Удалить сообщение?',
      body: <div className="rounded-lg bg-black/30 p-3 text-sm text-slate-300">{m.content || 'Вложение'}</div>,
      confirmLabel: 'Удалить',
      danger: true,
      onConfirm: () => useMessages.getState().remove(m),
    });

  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (m._status) return;
    ui.openContextMenu(e, [
      { label: 'Ответить', icon: <CornerUpLeft />, onClick: () => ui.setReplyTo(scope.id, m.id) },
      { label: 'Добавить реакцию', icon: <SmilePlus />, onClick: () => setPicker(true) },
      ...(mine && m.kind === 'default' ? [{ label: 'Редактировать', icon: <Pencil />, onClick: () => ui.setEditing(m.id) }] : []),
      { label: 'Копировать текст', icon: <Copy />, onClick: () => void navigator.clipboard.writeText(m.content) },
      { label: 'Копировать ID', icon: <Hash />, onClick: () => void navigator.clipboard.writeText(m.id) },
      ...(canDelete ? [{ separator: true, label: '' }, { label: 'Удалить', icon: <Trash2 />, danger: true, onClick: remove }] : []),
    ]);
  };

  const invites = [...m.content.matchAll(new RegExp(INVITE_LINK_RE, 'g'))].map((x) => x[1]).slice(0, 3);
  const emojiOnly = isEmojiOnly(m.content) && m.attachments.length === 0;
  const reactions = Object.entries(m.reactions);

  return (
    <div
      id={`msg-${m.id}`}
      onContextMenu={menu}
      className={`group relative px-4 transition-colors hover:bg-white/[0.03] ${grouped ? (compact ? 'py-0' : 'py-0.5') : compact ? 'pt-1.5' : 'pt-3.5'} ${
        mentioned ? 'msg-mentioned' : ''
      } ${m._status === 'sending' ? 'opacity-60' : ''}`}
    >
      {m.reply_to_id && <ReplyPreview scopeId={scope.id} id={m.reply_to_id} />}
      <div className="flex gap-4">
        <div className="w-10 shrink-0">
          {grouped && !m.reply_to_id ? (
            <span className="block pt-1 text-right text-[10px] text-slate-600 opacity-0 group-hover:opacity-100" title={formatFull(m.created_at)}>
              {formatTime(m.created_at)}
            </span>
          ) : (
            <button onClick={(e) => memberMenu(e, serverId, m.author_id)} className="mt-0.5">
              <Avatar userId={m.author_id} size={40} />
            </button>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {(!grouped || m.reply_to_id) && (
            <div className="flex items-baseline gap-2">
              <button
                className="truncate font-semibold text-white hover:underline"
                style={author?.accent_color ? { color: author.accent_color } : undefined}
                onClick={() => ui.openModal({ type: 'profile', userId: m.author_id, serverId: serverId ?? undefined })}
              >
                {name}
              </button>
              <UserBadge userId={m.author_id} />
              <span className="text-xs text-slate-500" title={formatFull(m.created_at)}>
                {formatMessageStamp(m.created_at)}
              </span>
            </div>
          )}
          {editing ? (
            <EditBox message={m} onDone={() => ui.setEditing(null)} />
          ) : (
            m.content && (
              <div className={`selectable whitespace-pre-wrap break-words leading-relaxed text-slate-200 ${emojiOnly ? 'text-4xl leading-tight' : 'text-[0.95rem]'}`}>
                {renderMessage(m.content, ctx)}
                {m.edited_at && <span className="ml-1 text-[10px] text-slate-500" title={formatFull(m.edited_at)}>(изменено)</span>}
              </div>
            )
          )}
          <Attachments list={m.attachments} pending={m._status === 'sending'} />
          {invites.map((code) => (
            <InviteEmbed key={code} code={code} />
          ))}
          {m._status === 'failed' && (
            <div className="mt-1 flex items-center gap-2 text-xs text-rose-300">
              <AlertTriangle className="h-3.5 w-3.5" /> {m._error ?? 'Не отправлено'}
              <button className="flex items-center gap-1 text-sky-300 hover:underline" onClick={() => void useMessages.getState().retry(scope, m.id).catch(() => undefined)}>
                <RotateCw className="h-3 w-3" /> Повторить
              </button>
              <button className="text-slate-400 hover:underline" onClick={() => useMessages.getState().discard(scope, m.id)}>
                Удалить
              </button>
            </div>
          )}
          {reactions.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {reactions.map(([emoji, users]) => {
                const mineR = users.includes(me);
                const names = users.slice(0, 8).map((u) => useProfiles.getState().byId[u]?.display_name ?? '…').join(', ');
                return (
                  <button
                    key={emoji}
                    title={names}
                    onClick={() => react(emoji)}
                    className={`flex items-center gap-1 rounded-lg border px-2 py-0.5 text-sm transition ${
                      mineR ? 'border-[color:var(--a2)] bg-[color:var(--a2)]/15 text-white' : 'border-white/10 bg-white/5 text-slate-300 hover:border-white/20'
                    }`}
                  >
                    <span>{emoji}</span>
                    <span className="text-xs tabular-nums">{users.length}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {!m._status && !editing && (
        <div className="glass-strong absolute -top-4 right-4 z-10 hidden items-center rounded-lg p-0.5 shadow-glass group-hover:flex">
          {QUICK_REACTIONS.slice(0, 4).map((e) => (
            <button key={e} onClick={() => react(e)} className="flex h-8 w-8 items-center justify-center rounded-md text-base hover:bg-white/10">
              {e}
            </button>
          ))}
          <button className="icon-btn" title="Реакция" onClick={() => setPicker(true)}>
            <SmilePlus className="h-4 w-4" />
          </button>
          <button className="icon-btn" title="Ответить" onClick={() => ui.setReplyTo(scope.id, m.id)}>
            <CornerUpLeft className="h-4 w-4" />
          </button>
          {mine && (
            <button className="icon-btn" title="Редактировать" onClick={() => ui.setEditing(m.id)}>
              <Pencil className="h-4 w-4" />
            </button>
          )}
          {canDelete && (
            <button className="icon-btn hover:text-rose-300" title="Удалить" onClick={remove}>
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
      {picker && <EmojiPicker className="absolute right-4 top-6" onPick={react} onClose={() => setPicker(false)} />}
    </div>
  );
});

export function lastOwnEditable(scopeId: string, me: string): Message | undefined {
  const list = useMessages.getState().byScope[scopeId]?.messages ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.author_id === me && !m.deleted_at && !m._status && m.kind === 'default') return m;
  }
  return undefined;
}
