import { Users } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { dmPeer, useSocial } from '@/stores/social';
import { useUi } from '@/stores/ui';
import { useUnread } from '@/stores/unread';
import { useProfile } from '@/stores/profiles';
import { Avatar } from '@/components/ui/Avatar';
import { UserBadge } from '@/components/ui/UserBadge';
import type { DmConversation } from '@/lib/types';

function DmRow({ dm, me, active }: { dm: DmConversation; me: string; active: boolean }) {
  const peer = dmPeer(dm, me);
  const profile = useProfile(peer);
  const unread = useUnread((s) => s.counts[dm.id]?.unread ?? 0);
  return (
    <button
      onClick={() => useUi.getState().setView({ kind: 'dm', dmId: dm.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        useUi.getState().openContextMenu(e, [
          { label: 'Профиль', onClick: () => useUi.getState().openModal({ type: 'profile', userId: peer }) },
          { label: 'Отметить как прочитанное', onClick: () => useUnread.getState().markRead(dm.id) },
        ]);
      }}
      className={`group flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition ${
        active ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
      }`}
    >
      <Avatar userId={peer} size={34} showStatus />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className={`truncate text-sm ${unread ? 'font-semibold text-white' : ''}`}>{profile?.display_name ?? '…'}</span>
          <UserBadge userId={peer} tag={false} />
        </div>
        {profile?.custom_status && <div className="truncate text-xs text-slate-500">{profile.custom_status}</div>}
      </div>
      {unread > 0 && <span className="rounded-full bg-rose-500 px-1.5 text-[11px] font-bold text-white">{unread}</span>}
    </button>
  );
}

export function HomeSidebar() {
  const me = useAuth((s) => s.userId)!;
  const dms = useSocial((s) => s.dms);
  const blocked = useSocial((s) => s.blocked);
  const view = useUi((s) => s.view);
  const pending = useSocial((s) => s.friendships.filter((f) => f.status === 'pending' && f.addressee_id === me).length);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center border-b border-white/5 px-3">
        <div className="w-full rounded-lg bg-black/30 px-3 py-1.5 text-sm text-slate-500">Личные сообщения</div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-3">
        <button
          onClick={() => useUi.getState().setView({ kind: 'home', tab: 'online' })}
          className={`mb-3 flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition ${
            view.kind === 'home' ? 'bg-white/10 text-white' : 'text-slate-300 hover:bg-white/5'
          }`}
        >
          <Users className="h-5 w-5" />
          <span className="flex-1 text-left">Друзья</span>
          {pending > 0 && <span className="rounded-full bg-rose-500 px-1.5 text-[11px] font-bold text-white">{pending}</span>}
        </button>
        <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Переписки</div>
        {dms
          .filter((d) => !blocked.includes(dmPeer(d, me)))
          .map((d) => (
            <DmRow key={d.id} dm={d} me={me} active={view.kind === 'dm' && view.dmId === d.id} />
          ))}
        {dms.length === 0 && (
          <div className="px-2 py-4 text-center text-xs text-slate-500">
            Здесь появятся ваши личные переписки
          </div>
        )}
      </div>
    </div>
  );
}
