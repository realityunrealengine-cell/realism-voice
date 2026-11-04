import { useEffect, useMemo } from 'react';
import { Crown, Shield, ShieldCheck } from 'lucide-react';
import { useServers } from '@/stores/servers';
import { useProfiles } from '@/stores/profiles';
import { usePresence } from '@/stores/presence';
import { useUi } from '@/stores/ui';
import { Avatar } from '@/components/ui/Avatar';
import { UserBadge } from '@/components/ui/UserBadge';
import { ROLE_LABEL, ROLE_RANK, type Member, type ServerRole } from '@/lib/types';
import { memberMenu } from '@/components/modals/memberMenu';

export const ROLE_ICON: Record<ServerRole, JSX.Element | null> = {
  owner: <Crown className="h-3.5 w-3.5 text-amber-300" />,
  admin: <ShieldCheck className="h-3.5 w-3.5 text-rose-300" />,
  moderator: <Shield className="h-3.5 w-3.5 text-sky-300" />,
  member: null,
};

function MemberRow({ m, offline }: { m: Member; offline: boolean }) {
  const p = useProfiles((s) => s.byId[m.user_id]);
  return (
    <button
      onClick={() => useUi.getState().openModal({ type: 'profile', userId: m.user_id, serverId: m.server_id })}
      onContextMenu={(e) => {
        e.preventDefault();
        memberMenu(e, m.server_id, m.user_id);
      }}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/5 ${offline ? 'opacity-45' : ''}`}
    >
      <Avatar userId={m.user_id} size={32} showStatus />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-sm text-slate-200">{m.nickname || p?.display_name || '…'}</span>
          <UserBadge userId={m.user_id} />
          {ROLE_ICON[m.role]}
        </div>
        {p?.custom_status && <div className="truncate text-xs text-slate-500">{p.custom_status}</div>}
      </div>
    </button>
  );
}

export function MemberList({ serverId }: { serverId: string }) {
  const members = useServers((s) => s.members[serverId]);
  const loaded = useServers((s) => s.membersLoaded[serverId]);
  const online = usePresence((s) => s.online);
  const profiles = useProfiles((s) => s.byId);

  useEffect(() => {
    if (!loaded) void useServers.getState().loadMembers(serverId);
  }, [serverId, loaded]);

  const groups = useMemo(() => {
    const list = members ?? [];
    const name = (m: Member) => (m.nickname || profiles[m.user_id]?.display_name || '').toLowerCase();
    const sorted = [...list].sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || name(a).localeCompare(name(b)));
    const on = sorted.filter((m) => online[m.user_id]);
    const off = sorted.filter((m) => !online[m.user_id]);
    const byRole: { title: string; list: Member[]; offline: boolean }[] = [];
    for (const role of ['owner', 'admin', 'moderator', 'member'] as ServerRole[]) {
      const l = on.filter((m) => m.role === role);
      if (l.length) byRole.push({ title: `${role === 'member' ? 'В сети' : ROLE_LABEL[role]} — ${l.length}`, list: l, offline: false });
    }
    if (off.length) byRole.push({ title: `Не в сети — ${off.length}`, list: off, offline: true });
    return byRole;
  }, [members, online, profiles]);

  return (
    <div className="h-full w-[248px] overflow-y-auto px-2 py-4">
      {!members && <div className="px-2 text-sm text-slate-500">Загрузка участников…</div>}
      {groups.map((g) => (
        <div key={g.title} className="mb-4">
          <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{g.title}</div>
          {g.list.map((m) => (
            <MemberRow key={m.user_id} m={m} offline={g.offline} />
          ))}
        </div>
      ))}
    </div>
  );
}
