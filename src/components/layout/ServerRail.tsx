import { motion } from 'framer-motion';
import { Compass, LogOut, Plus, Settings, UserPlus, BellOff, Bell, Copy } from 'lucide-react';
import { useServers } from '@/stores/servers';
import { useUi } from '@/stores/ui';
import { serverUnread, useUnread } from '@/stores/unread';
import { useSettings } from '@/stores/settings';
import { useAuth } from '@/stores/auth';
import { useSocial } from '@/stores/social';
import { LogoMark } from '@/components/ui/Logo';
import { ServerIcon } from '@/components/ui/Avatar';
import { roleAtLeast } from '@/lib/types';
import { toast } from '@/stores/ui';
import type { ReactNode } from 'react';

function RailItem({
  active,
  unread,
  mentions,
  tooltip,
  onClick,
  onContextMenu,
  children,
}: {
  active: boolean;
  unread?: boolean;
  mentions?: number;
  tooltip: string;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <div className="group relative flex w-full justify-center">
      <motion.span
        className="absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-white"
        animate={{ height: active ? 36 : unread ? 8 : 0, opacity: active || unread ? 1 : 0 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      />
      <motion.button
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.96 }}
        onClick={onClick}
        onContextMenu={onContextMenu}
        title={tooltip}
        className={`relative h-12 w-12 overflow-hidden transition-all duration-200 ${
          active ? 'accent-ring rounded-2xl' : 'rounded-[24px] hover:rounded-2xl'
        }`}
      >
        {children}
      </motion.button>
      {!!mentions && mentions > 0 && (
        <span className="pointer-events-none absolute bottom-0 right-2 min-w-[18px] rounded-full bg-rose-500 px-1 text-center text-[11px] font-bold leading-[18px] text-white ring-[3px] ring-base-950">
          {mentions > 99 ? '99+' : mentions}
        </span>
      )}
    </div>
  );
}

export function ServerRail() {
  const servers = useServers((s) => s.servers);
  const myRoles = useServers((s) => s.myRoles);
  const view = useUi((s) => s.view);
  const counts = useUnread((s) => s.counts);
  const muted = useSettings((s) => s.prefs.notifications.mutedServers);
  const pending = useSocial((s) => s.friendships.filter((f) => f.status === 'pending' && f.addressee_id === useAuth.getState().userId).length);
  const dmUnread = Object.values(counts).filter((c) => c.serverId === null).reduce((a, c) => a + c.unread, 0);
  const { openModal, setView, openContextMenu } = useUi.getState();

  return (
    <nav className="flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-black/30 py-3">
      <RailItem
        active={view.kind === 'home' || view.kind === 'dm'}
        tooltip="Друзья и личные сообщения"
        mentions={dmUnread + pending}
        onClick={() => setView({ kind: 'home', tab: 'online' })}
      >
        <div className="flex h-full w-full items-center justify-center bg-white/5">
          <LogoMark size={36} />
        </div>
      </RailItem>
      <div className="h-px w-8 bg-white/10" />
      {servers.map((s) => {
        const u = serverUnread(counts, s.id, muted.includes(s.id));
        const isMuted = muted.includes(s.id);
        return (
          <RailItem
            key={s.id}
            active={view.kind === 'server' && view.serverId === s.id}
            unread={u.unread > 0}
            mentions={u.mentions}
            tooltip={s.name}
            onClick={() => setView({ kind: 'server', serverId: s.id })}
            onContextMenu={(e) => {
              e.preventDefault();
              const role = myRoles[s.id];
              openContextMenu(e, [
                { label: 'Пригласить людей', icon: <UserPlus />, onClick: () => openModal({ type: 'invite', serverId: s.id }) },
                {
                  label: isMuted ? 'Включить уведомления' : 'Отключить уведомления',
                  icon: isMuted ? <Bell /> : <BellOff />,
                  onClick: () =>
                    useSettings.getState().setNotifications({
                      mutedServers: isMuted ? muted.filter((x) => x !== s.id) : [...muted, s.id],
                    }),
                },
                ...(roleAtLeast(role, 'moderator')
                  ? [{ label: 'Настройки сервера', icon: <Settings />, onClick: () => openModal({ type: 'serverSettings', serverId: s.id }) }]
                  : []),
                { label: 'Копировать ID', icon: <Copy />, onClick: () => void navigator.clipboard.writeText(s.id) },
                { separator: true, label: '' },
                ...(role !== 'owner'
                  ? [
                      {
                        label: 'Покинуть сервер',
                        icon: <LogOut />,
                        danger: true,
                        onClick: () =>
                          openModal({
                            type: 'confirm',
                            title: `Покинуть «${s.name}»?`,
                            body: 'Вы сможете вернуться только по новому приглашению.',
                            confirmLabel: 'Покинуть',
                            danger: true,
                            onConfirm: async () => {
                              await useServers.getState().leaveServer(s.id);
                              toast.success('Вы покинули сервер');
                            },
                          }),
                      },
                    ]
                  : []),
              ]);
            }}
          >
            <ServerIcon id={s.id} name={s.name} iconPath={s.icon_path} />
          </RailItem>
        );
      })}
      <RailItem active={false} tooltip="Создать сервер" onClick={() => openModal({ type: 'createServer' })}>
        <div className="flex h-full w-full items-center justify-center bg-white/5 text-emerald-400 transition hover:bg-emerald-500 hover:text-white">
          <Plus className="h-6 w-6" />
        </div>
      </RailItem>
      <RailItem active={false} tooltip="Присоединиться по приглашению" onClick={() => openModal({ type: 'joinServer' })}>
        <div className="flex h-full w-full items-center justify-center bg-white/5 text-sky-300 transition hover:bg-sky-500 hover:text-white">
          <Compass className="h-6 w-6" />
        </div>
      </RailItem>
    </nav>
  );
}
