import { useEffect, useMemo, useRef } from 'react';
import { AtSign, Hash, Lock, Phone, Users, Video } from 'lucide-react';
import type { Scope } from '@/lib/types';
import { roleAtLeast, ROLE_LABEL } from '@/lib/types';
import { useMessages } from '@/stores/messages';
import { useServers } from '@/stores/servers';
import { useAuth } from '@/stores/auth';
import { dmPeer, useSocial } from '@/stores/social';
import { useProfile, useProfiles } from '@/stores/profiles';
import { useUnread } from '@/stores/unread';
import { useUi } from '@/stores/ui';
import { useVoice } from '@/stores/voice';
import { formatDay, sameDay } from '@/lib/format';
import { Avatar } from '@/components/ui/Avatar';
import { UserBadge } from '@/components/ui/UserBadge';
import { Spinner } from '@/components/ui/primitives';
import { MessageItem } from './MessageItem';
import { Composer } from './Composer';
import { useTyping } from './useTyping';

function TypingLine({ typers }: { typers: string[] }) {
  const profiles = useProfiles((s) => s.byId);
  if (typers.length === 0) return <div className="h-5" />;
  const names = typers.map((id) => profiles[id]?.display_name ?? '…');
  const text =
    names.length === 1
      ? `${names[0]} печатает…`
      : names.length <= 3
        ? `${names.join(', ')} печатают…`
        : 'Несколько человек печатают…';
  return (
    <div className="flex h-5 items-center gap-2 px-5 text-xs text-slate-400">
      <span className="flex gap-0.5">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </span>
      {text}
    </div>
  );
}

function DmHeader({ dmId }: { dmId: string }) {
  const me = useAuth((s) => s.userId)!;
  const dm = useSocial((s) => s.dms.find((d) => d.id === dmId));
  const peer = dm ? dmPeer(dm, me) : null;
  const profile = useProfile(peer);
  const voice = useVoice((s) => s.target);
  const inCall = voice?.kind === 'dm' && voice.dmId === dmId;
  const call = async (video: boolean) => {
    if (!peer) return;
    if (!inCall) await useVoice.getState().join({ kind: 'dm', dmId, peerId: peer, name: profile?.display_name ?? 'Звонок' });
    if (video && useVoice.getState().status === 'connected' && !useVoice.getState().camera) await useVoice.getState().toggleCamera();
    useUi.getState().setVoiceViewOpen(true);
  };
  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {peer && <Avatar userId={peer} size={28} showStatus />}
        <span className="truncate font-semibold text-white">{profile?.display_name ?? '…'}</span>
        <UserBadge userId={peer} />
        {profile && <span className="truncate text-sm text-slate-500">@{profile.username}</span>}
      </div>
      <button className="icon-btn" title="Голосовой звонок" onClick={() => void call(false)}>
        <Phone className="h-[18px] w-[18px]" />
      </button>
      <button className="icon-btn" title="Видеозвонок" onClick={() => void call(true)}>
        <Video className="h-[18px] w-[18px]" />
      </button>
      {peer && (
        <button className="icon-btn" title="Профиль" onClick={() => useUi.getState().openModal({ type: 'profile', userId: peer })}>
          <AtSign className="h-[18px] w-[18px]" />
        </button>
      )}
    </>
  );
}

export function ChatView({ scope }: { scope: Scope }) {
  const state = useMessages((s) => s.byScope[scope.id]);
  const me = useAuth((s) => s.userId)!;
  const channel = useServers((s) =>
    scope.kind === 'channel' ? Object.values(s.channels).flat().find((c) => c.id === scope.id) : undefined,
  );
  const serverId = channel?.server_id ?? null;
  const role = useServers((s) => (serverId ? s.myRoles[serverId] : undefined));
  const dm = useSocial((s) => (scope.kind === 'dm' ? s.dms.find((d) => d.id === scope.id) : undefined));
  const blocked = useSocial((s) => s.blocked);
  const peer = dm ? dmPeer(dm, me) : null;
  const peerProfile = useProfile(peer);
  const { typers, notify, stop, clear } = useTyping(scope);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = state?.messages ?? [];

  useEffect(() => {
    void useMessages.getState().load(scope);
    useUnread.getState().markRead(scope.id);
    if (serverId) {
      // Запоминаем открытый канал, чтобы непрочитанные корректно считались для активного канала
      const ui = useUi.getState();
      if (ui.lastChannel[serverId] !== scope.id) useUi.setState({ lastChannel: { ...ui.lastChannel, [serverId]: scope.id } });
      if (!useServers.getState().membersLoaded[serverId]) void useServers.getState().loadMembers(serverId);
    }
  }, [scope.id, scope.kind, serverId]);

  // Новые сообщения в открытом чате — отмечаем прочитанным и прячем «печатает»
  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last) return;
    clear(last.author_id);
    if (document.hasFocus()) useUnread.getState().markRead(scope.id);
    const el = scrollRef.current;
    if (el && last.author_id === me) el.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId]);

  useEffect(() => {
    const onFocus = () => useUnread.getState().markRead(scope.id);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [scope.id]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // column-reverse: scrollTop отрицательный, верх истории — при максимальном |scrollTop|
    const distanceToTop = el.scrollHeight - el.clientHeight + el.scrollTop;
    if (distanceToTop < 300 && state?.hasMore && !state.loading) void useMessages.getState().loadOlder(scope);
  };

  const rendered = useMemo(() => {
    const out: JSX.Element[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const prev = messages[i - 1];
      if (!prev || !sameDay(prev.created_at, m.created_at)) {
        out.push(
          <div key={`d-${m.id}`} className="my-3 flex items-center gap-3 px-4">
            <div className="h-px flex-1 bg-white/10" />
            <span className="text-[11px] font-semibold text-slate-500">{formatDay(m.created_at)}</span>
            <div className="h-px flex-1 bg-white/10" />
          </div>,
        );
      }
      const grouped =
        !!prev &&
        prev.author_id === m.author_id &&
        prev.kind === 'default' &&
        m.kind === 'default' &&
        !prev.deleted_at &&
        sameDay(prev.created_at, m.created_at) &&
        new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60_000;
      out.push(<MessageItem key={m.id} message={m} scope={scope} serverId={serverId} grouped={grouped} />);
    }
    return out.reverse();
  }, [messages, scope, serverId]);

  const canSend = scope.kind === 'channel' ? !channel || roleAtLeast(role, channel.send_min_role) : true;
  let disabled: string | null = null;
  if (scope.kind === 'channel' && !canSend && channel)
    disabled = `Писать в этот канал могут роли от «${ROLE_LABEL[channel.send_min_role]}» и выше`;
  if (scope.kind === 'dm' && peer && blocked.includes(peer)) disabled = 'Вы заблокировали этого пользователя';

  const placeholder = scope.kind === 'channel' ? `Написать в #${channel?.name ?? ''}` : `Написать @${peerProfile?.display_name ?? ''}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-white/5 px-4">
        {scope.kind === 'channel' ? (
          <>
            <Hash className="h-5 w-5 shrink-0 text-slate-500" />
            <span className="font-semibold text-white">{channel?.name}</span>
            {channel?.is_private && <Lock className="h-3.5 w-3.5 text-slate-500" />}
            {channel?.topic && (
              <>
                <div className="mx-2 h-5 w-px bg-white/10" />
                <span className="truncate text-sm text-slate-400">{channel.topic}</span>
              </>
            )}
            <div className="flex-1" />
            <button className="icon-btn" title="Участники" onClick={() => useUi.getState().toggleMemberList()}>
              <Users className="h-[18px] w-[18px]" />
            </button>
          </>
        ) : (
          <DmHeader dmId={scope.id} />
        )}
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto pb-2">
        {rendered}
        {state?.loading && (
          <div className="flex justify-center py-4">
            <Spinner className="h-5 w-5 text-slate-500" />
          </div>
        )}
        {state && !state.hasMore && (
          <div className="px-4 pb-4 pt-10">
            {scope.kind === 'channel' ? (
              <>
                <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/5">
                  <Hash className="h-9 w-9 text-slate-300" />
                </div>
                <h2 className="text-2xl font-bold text-white">Добро пожаловать в #{channel?.name}!</h2>
                <p className="mt-1 text-sm text-slate-400">Это начало канала.</p>
              </>
            ) : (
              <>
                {peer && <Avatar userId={peer} size={72} />}
                <h2 className="mt-3 text-2xl font-bold text-white">{peerProfile?.display_name}</h2>
                <p className="mt-1 text-sm text-slate-400">Начало вашей личной переписки с @{peerProfile?.username}.</p>
              </>
            )}
          </div>
        )}
        {state?.error && <div className="px-4 py-2 text-sm text-rose-300">{state.error}</div>}
      </div>

      <TypingLine typers={typers} />
      <Composer
        scope={scope}
        serverId={serverId}
        placeholder={placeholder}
        disabled={disabled}
        onTyping={notify}
        onStopTyping={stop}
        mentionCandidates={peer ? [peer, me] : [me]}
      />
    </div>
  );
}
