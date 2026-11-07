import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronDown, ChevronRight, Copy, FolderPlus, Hash, Headphones, Lock, LogOut, MicOff, Monitor, Pencil, Plus, Settings, Trash2, UserPlus, Video, Volume2,
  ArrowUp, ArrowDown, HeadphoneOff,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useServers } from '@/stores/servers';
import { useUi, toast } from '@/stores/ui';
import { useUnread } from '@/stores/unread';
import { usePresence, type VoiceMember } from '@/stores/presence';
import { liveParticipants, useVoice } from '@/stores/voice';
import { channelRoster, serverRoster } from '@/lib/voiceRoster';
import { useProfile } from '@/stores/profiles';
import { Avatar } from '@/components/ui/Avatar';
import { UserBadge } from '@/components/ui/UserBadge';
import { roleAtLeast, type Channel } from '@/lib/types';

function VoiceMemberRow({ m, speaking }: { m: VoiceMember; speaking: boolean }) {
  const p = useProfile(m.user_id);
  return (
    <div
      className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-slate-400 hover:bg-white/5"
      onClick={() => useUi.getState().openModal({ type: 'profile', userId: m.user_id })}
    >
      <Avatar userId={m.user_id} size={22} speaking={speaking} />
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <span className={`truncate ${speaking ? 'text-white' : ''}`}>{p?.display_name ?? '…'}</span>
        <UserBadge userId={m.user_id} tag={false} />
      </span>
      {m.screen && <Monitor className="h-3.5 w-3.5 text-rose-400" />}
      {m.camera && <Video className="h-3.5 w-3.5 text-slate-400" />}
      {m.deafened ? <HeadphoneOff className="h-3.5 w-3.5 text-rose-400" /> : m.muted ? <MicOff className="h-3.5 w-3.5 text-rose-400" /> : null}
    </div>
  );
}

export function ChannelSidebar({ serverId }: { serverId: string }) {
  const server = useServers((s) => s.servers.find((x) => x.id === serverId));
  const categories = useServers((s) => s.categories[serverId]) ?? [];
  const channels = useServers((s) => s.channels[serverId]) ?? [];
  const role = useServers((s) => s.myRoles[serverId]);
  const counts = useUnread((s) => s.counts);
  const presenceMembers = usePresence((s) => s.voice[serverId]);
  const voiceTarget = useVoice((s) => s.target);
  const voiceStatus = useVoice((s) => s.status);
  const participants = useVoice((s) => s.participants);
  const lastChannel = useUi((s) => s.lastChannel[serverId]);
  const voiceViewOpen = useUi((s) => s.voiceViewOpen);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);
  const isAdmin = roleAtLeast(role, 'admin');
  const ui = useUi.getState();

  const firstText = channels.find((c) => c.type === 'text');
  const activeText = lastChannel ?? firstText?.id;

  const groups = useMemo(() => {
    const out: { id: string | null; name: string; channels: Channel[] }[] = [];
    const uncategorized = channels.filter((c) => !c.category_id || !categories.some((k) => k.id === c.category_id));
    if (uncategorized.length) out.push({ id: null, name: '', channels: uncategorized });
    for (const cat of categories) out.push({ id: cat.id, name: cat.name, channels: channels.filter((c) => c.category_id === cat.id) });
    return out;
  }, [channels, categories]);

  // Для канала, к которому подключены мы сами, состав берётся из LiveKit (как и счётчик в голосовом окне)
  const liveChannelId =
    voiceTarget?.kind === 'channel' && voiceTarget.serverId === serverId && voiceStatus === 'connected' ? voiceTarget.channelId : null;
  const live = useMemo(() => (liveChannelId ? liveParticipants(participants) : null), [liveChannelId, participants]);
  const voiceMembers = useMemo(() => serverRoster(presenceMembers ?? [], liveChannelId, live), [presenceMembers, liveChannelId, live]);

  if (!server) return null;

  const speakingIds = new Set(participants.filter((p) => p.speaking).map((p) => p.identity));

  const openChannel = (c: Channel) => {
    if (c.type === 'text') {
      ui.openChannel(serverId, c.id);
      return;
    }
    const inThis = voiceTarget?.kind === 'channel' && voiceTarget.channelId === c.id;
    if (!inThis) void useVoice.getState().join({ kind: 'channel', serverId, channelId: c.id, name: c.name });
    ui.setView({ kind: 'server', serverId });
    ui.setVoiceViewOpen(true);
  };

  const channelMenu = (e: React.MouseEvent, c: Channel) => {
    e.preventDefault();
    ui.openContextMenu(e, [
      ...(c.type === 'text'
        ? [{ label: 'Отметить как прочитанное', icon: <Hash />, onClick: () => useUnread.getState().markRead(c.id) }]
        : [{ label: 'Подключиться', icon: <Volume2 />, onClick: () => openChannel(c) }]),
      { label: 'Пригласить людей', icon: <UserPlus />, onClick: () => ui.openModal({ type: 'invite', serverId }) },
      { label: 'Копировать ID канала', icon: <Copy />, onClick: () => void navigator.clipboard.writeText(c.id) },
      ...(isAdmin
        ? [
            { separator: true, label: '' },
            { label: 'Настройки канала', icon: <Settings />, onClick: () => ui.openModal({ type: 'channelSettings', channelId: c.id }) },
            {
              label: 'Удалить канал',
              icon: <Trash2 />,
              danger: true,
              onClick: () =>
                ui.openModal({
                  type: 'confirm',
                  title: `Удалить «${c.name}»?`,
                  body: 'Канал и вся его история будут удалены без возможности восстановления.',
                  confirmLabel: 'Удалить',
                  danger: true,
                  onConfirm: () => useServers.getState().deleteChannel(c.id),
                }),
            },
          ]
        : []),
    ]);
  };

  const categoryMenu = (e: React.MouseEvent, id: string, name: string) => {
    if (!isAdmin) return;
    e.preventDefault();
    ui.openContextMenu(e, [
      { label: 'Создать канал', icon: <Plus />, onClick: () => ui.openModal({ type: 'createChannel', serverId, categoryId: id }) },
      {
        label: 'Переименовать',
        icon: <Pencil />,
        onClick: () => ui.openModal({ type: 'createCategory', serverId, categoryId: id, name }),
      },
      { label: 'Переместить выше', icon: <ArrowUp />, onClick: () => void useServers.getState().moveCategory(id, -1).catch((err) => toast.error('Ошибка', err.message)) },
      { label: 'Переместить ниже', icon: <ArrowDown />, onClick: () => void useServers.getState().moveCategory(id, 1).catch((err) => toast.error('Ошибка', err.message)) },
      {
        label: 'Удалить категорию',
        icon: <Trash2 />,
        danger: true,
        onClick: () =>
          ui.openModal({
            type: 'confirm',
            title: `Удалить категорию «${name}»?`,
            body: 'Каналы останутся, но будут без категории.',
            confirmLabel: 'Удалить',
            danger: true,
            onConfirm: () => useServers.getState().deleteCategory(id),
          }),
      },
    ]);
  };

  const drop = (categoryId: string | null, beforeId: string | null) => {
    const id = dragId;
    setDragId(null);
    setDropHint(null);
    if (!id) return;
    void useServers.getState().moveChannel(id, categoryId, beforeId).catch((err) => toast.error('Не удалось переместить', err.message));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="relative">
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="flex h-12 w-full items-center justify-between border-b border-white/5 px-4 text-left font-semibold text-white transition hover:bg-white/5"
        >
          <span className="truncate">{server.name}</span>
          <ChevronDown className={`h-4 w-4 shrink-0 transition ${menuOpen ? 'rotate-180' : ''}`} />
        </button>
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="glass-strong absolute left-2 right-2 top-[52px] z-30 rounded-xl p-1.5 shadow-glass"
              onMouseLeave={() => setMenuOpen(false)}
            >
              {[
                { label: 'Пригласить людей', icon: <UserPlus />, show: true, onClick: () => ui.openModal({ type: 'invite', serverId }) },
                { label: 'Настройки сервера', icon: <Settings />, show: roleAtLeast(role, 'moderator'), onClick: () => ui.openModal({ type: 'serverSettings', serverId }) },
                { label: 'Создать канал', icon: <Plus />, show: isAdmin, onClick: () => ui.openModal({ type: 'createChannel', serverId, categoryId: null }) },
                { label: 'Создать категорию', icon: <FolderPlus />, show: isAdmin, onClick: () => ui.openModal({ type: 'createCategory', serverId }) },
                {
                  label: 'Покинуть сервер', icon: <LogOut />, show: role !== 'owner', danger: true,
                  onClick: () =>
                    ui.openModal({
                      type: 'confirm', title: `Покинуть «${server.name}»?`, body: 'Вернуться можно будет только по приглашению.', confirmLabel: 'Покинуть', danger: true,
                      onConfirm: () => useServers.getState().leaveServer(serverId),
                    }),
                },
              ]
                .filter((i) => i.show)
                .map((i) => (
                  <button
                    key={i.label}
                    onClick={() => {
                      setMenuOpen(false);
                      i.onClick();
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm [&>svg]:h-4 [&>svg]:w-4 ${
                      i.danger ? 'text-rose-300 hover:bg-rose-500/20' : 'text-slate-200 hover:bg-white/10'
                    }`}
                  >
                    {i.icon}
                    {i.label}
                  </button>
                ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-2 py-3">
        {groups.map((g) => (
          <div key={g.id ?? 'none'}>
            {g.id && (
              <div
                className={`group flex items-center justify-between rounded px-1 pb-1 ${dropHint === `cat:${g.id}` ? 'bg-white/5' : ''}`}
                onContextMenu={(e) => categoryMenu(e, g.id!, g.name)}
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  setDropHint(`cat:${g.id}`);
                }}
                onDrop={() => drop(g.id, null)}
              >
                <button
                  className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-300"
                  onClick={() => setCollapsed({ ...collapsed, [g.id!]: !collapsed[g.id!] })}
                >
                  {collapsed[g.id] ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  {g.name}
                </button>
                {isAdmin && (
                  <button
                    className="text-slate-500 opacity-0 transition hover:text-slate-200 group-hover:opacity-100"
                    title="Создать канал"
                    onClick={() => ui.openModal({ type: 'createChannel', serverId, categoryId: g.id })}
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                )}
              </div>
            )}
            {g.channels
              .filter((c) => !collapsed[g.id ?? ''] || (c.type === 'text' && c.id === activeText) || (counts[c.id]?.unread ?? 0) > 0)
              .map((c) => {
                const unread = counts[c.id];
                const isActiveText = c.type === 'text' && c.id === activeText && !voiceViewOpen;
                const inVoice = voiceTarget?.kind === 'channel' && voiceTarget.channelId === c.id;
                const members = c.type === 'voice' ? channelRoster(c.id, voiceMembers, c.id === liveChannelId ? live : null) : [];
                return (
                  <div key={c.id}>
                    <div
                      draggable={isAdmin}
                      onDragStart={() => setDragId(c.id)}
                      onDragEnd={() => {
                        setDragId(null);
                        setDropHint(null);
                      }}
                      onDragOver={(e) => {
                        if (!dragId || dragId === c.id) return;
                        e.preventDefault();
                        setDropHint(c.id);
                      }}
                      onDrop={() => drop(g.id, c.id)}
                      onClick={() => openChannel(c)}
                      onContextMenu={(e) => channelMenu(e, c)}
                      className={`group relative mb-0.5 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[15px] transition ${
                        isActiveText || (inVoice && voiceViewOpen) ? 'bg-white/10 text-white' : unread ? 'text-white hover:bg-white/5' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                      } ${dropHint === c.id ? 'border-t-2 border-[color:var(--a2)]' : ''}`}
                    >
                      {unread && !isActiveText && <span className="absolute -left-2 h-2 w-1 rounded-r-full bg-white" />}
                      {c.type === 'text' ? <Hash className="h-4 w-4 shrink-0 opacity-70" /> : <Volume2 className={`h-4 w-4 shrink-0 ${inVoice ? 'text-emerald-400' : 'opacity-70'}`} />}
                      <span className={`min-w-0 flex-1 truncate ${unread ? 'font-semibold' : ''}`}>{c.name}</span>
                      {c.is_private && <Lock className="h-3 w-3 shrink-0 opacity-60" />}
                      {c.type === 'voice' && c.user_limit && (
                        <span className="rounded bg-black/30 px-1 text-[10px] tabular-nums text-slate-400">
                          {members.length}/{c.user_limit}
                        </span>
                      )}
                      {!!unread?.mentions && (
                        <span className="rounded-full bg-rose-500 px-1.5 text-[11px] font-bold text-white">{unread.mentions}</span>
                      )}
                      {isAdmin && (
                        <button
                          className="opacity-0 transition hover:text-white group-hover:opacity-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            ui.openModal({ type: 'channelSettings', channelId: c.id });
                          }}
                          title="Настройки канала"
                        >
                          <Settings className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    {members.length > 0 && (
                      <div className="mb-1 ml-6 space-y-0.5">
                        {members.map((m) => (
                          <VoiceMemberRow key={m.user_id} m={m} speaking={inVoice && speakingIds.has(m.user_id)} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            {g.channels.length === 0 && g.id && isAdmin && (
              <div
                className={`rounded-lg px-2 py-1 text-xs text-slate-600 ${dropHint === `cat:${g.id}` ? 'bg-white/5' : ''}`}
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  setDropHint(`cat:${g.id}`);
                }}
                onDrop={() => drop(g.id, null)}
              >
                Пусто — перетащите сюда канал
              </div>
            )}
          </div>
        ))}
        {channels.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-slate-500">
            <Headphones className="mx-auto mb-2 h-6 w-6" />
            Каналов пока нет
          </div>
        )}
      </div>
    </div>
  );
}
