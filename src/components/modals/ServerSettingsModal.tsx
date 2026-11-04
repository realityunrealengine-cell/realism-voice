import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Crown, Search, Trash2, X } from 'lucide-react';
import { useServers } from '@/stores/servers';
import { useProfiles } from '@/stores/profiles';
import { useAuth } from '@/stores/auth';
import { toast, useUi } from '@/stores/ui';
import { supabase, publicUrl } from '@/lib/supabase';
import { errorMessage } from '@/lib/errors';
import { formatMessageStamp, inviteLink } from '@/lib/format';
import { IMAGE_MIME } from '@/lib/media';
import { ROLE_LABEL, ROLE_RANK, roleAtLeast, type Ban, type Invite } from '@/lib/types';
import { Avatar, ServerIcon } from '@/components/ui/Avatar';
import { UserBadge } from '@/components/ui/UserBadge';
import { Field, ModalShell, Spinner, Switch } from '@/components/ui/primitives';
import { memberMenu } from './memberMenu';
import { ROLE_ICON } from '@/components/layout/MemberList';

type Tab = 'overview' | 'members' | 'invites' | 'bans' | 'danger';

function Overview({ serverId }: { serverId: string }) {
  const server = useServers((s) => s.servers.find((x) => x.id === serverId))!;
  const role = useServers((s) => s.myRoles[serverId]);
  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description);
  const [membersCanInvite, setMembersCanInvite] = useState(server.members_can_invite);
  const [icon, setIcon] = useState<File | null>(null);
  const [removeIcon, setRemoveIcon] = useState(false);
  const [preview, setPreview] = useState<string | null>(publicUrl('server-icons', server.icon_path));
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canEdit = roleAtLeast(role, 'admin');

  const save = async () => {
    setBusy(true);
    try {
      await useServers.getState().updateServer(serverId, { name, description, members_can_invite: membersCanInvite, icon, removeIcon });
      setIcon(null);
      setRemoveIcon(false);
      toast.success('Изменения сохранены');
    } catch (e) {
      toast.error('Не удалось сохранить', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-5">
        <button
          disabled={!canEdit}
          onClick={() => fileRef.current?.click()}
          className="group relative h-24 w-24 overflow-hidden rounded-3xl bg-black/30"
        >
          {preview ? <img src={preview} alt="" className="h-full w-full object-cover" /> : <ServerIcon id={server.id} name={name} iconPath={null} size={96} />}
          {canEdit && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition group-hover:opacity-100">
              <Camera className="h-6 w-6" />
            </span>
          )}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={IMAGE_MIME.join(',')}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setIcon(f);
            setRemoveIcon(false);
            setPreview(URL.createObjectURL(f));
          }}
        />
        <div className="text-sm text-slate-400">
          Рекомендуем квадратное изображение не меньше 256×256, до 5 МБ.
          {canEdit && preview && (
            <button
              className="mt-2 block text-rose-300 hover:underline"
              onClick={() => {
                setIcon(null);
                setRemoveIcon(true);
                setPreview(null);
              }}
            >
              Удалить иконку
            </button>
          )}
        </div>
      </div>
      <Field label="Название сервера">
        <input className="input" value={name} maxLength={64} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Описание">
        <textarea className="input resize-none" rows={3} maxLength={300} disabled={!canEdit} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <label className="flex items-center justify-between rounded-xl bg-black/20 px-4 py-3">
        <span>
          <span className="block text-sm text-white">Участники могут приглашать</span>
          <span className="text-xs text-slate-500">Иначе приглашения создают только модераторы и выше</span>
        </span>
        <Switch checked={membersCanInvite} onChange={setMembersCanInvite} disabled={!canEdit} />
      </label>
      {canEdit && (
        <div className="flex justify-end">
          <button className="btn-primary" disabled={busy || name.trim().length < 2} onClick={() => void save()}>
            {busy && <Spinner />} Сохранить изменения
          </button>
        </div>
      )}
    </div>
  );
}

function Members({ serverId }: { serverId: string }) {
  const members = useServers((s) => s.members[serverId]);
  const myRole = useServers((s) => s.myRoles[serverId]);
  const profiles = useProfiles((s) => s.byId);
  const me = useAuth((s) => s.userId);
  const [q, setQ] = useState('');
  useEffect(() => {
    void useServers.getState().loadMembers(serverId);
  }, [serverId]);
  const list = useMemo(
    () =>
      [...(members ?? [])]
        .filter((m) => {
          const p = profiles[m.user_id];
          const t = q.toLowerCase();
          return !t || p?.display_name.toLowerCase().includes(t) || p?.username.includes(t) || m.nickname?.toLowerCase().includes(t);
        })
        .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role]),
    [members, profiles, q],
  );
  return (
    <div>
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <input className="input pl-9" placeholder="Поиск участников" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="text-xs text-slate-500">Всего: {members?.length ?? 0}. Нажмите на участника, чтобы изменить роль, выгнать или забанить.</div>
      <div className="mt-2 space-y-0.5">
        {list.map((m) => (
          <button
            key={m.user_id}
            onClick={(e) => memberMenu(e, serverId, m.user_id)}
            onContextMenu={(e) => {
              e.preventDefault();
              memberMenu(e, serverId, m.user_id);
            }}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/5"
          >
            <Avatar userId={m.user_id} size={32} showStatus />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-white">
                {m.nickname || profiles[m.user_id]?.display_name || '…'} <UserBadge userId={m.user_id} /> {m.user_id === me && <span className="text-slate-500">(вы)</span>}
              </div>
              <div className="text-xs text-slate-500">@{profiles[m.user_id]?.username}</div>
            </div>
            <span className="flex items-center gap-1 text-xs text-slate-400">
              {ROLE_ICON[m.role]} {ROLE_LABEL[m.role]}
            </span>
          </button>
        ))}
      </div>
      {myRole && !roleAtLeast(myRole, 'admin') && <p className="mt-3 text-xs text-slate-500">Модераторы могут выгонять участников. Роли меняют администраторы.</p>}
    </div>
  );
}

function Invites({ serverId }: { serverId: string }) {
  const [list, setList] = useState<Invite[] | null>(null);
  const profiles = useProfiles((s) => s.byId);
  const load = async () => {
    const { data } = await supabase.from('invites').select('*').eq('server_id', serverId).order('created_at', { ascending: false });
    const rows = (data ?? []) as Invite[];
    useProfiles.getState().ensure(rows.map((r) => r.created_by));
    setList(rows);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);
  const active = (i: Invite) => !i.revoked && (!i.expires_at || new Date(i.expires_at) > new Date()) && (!i.max_uses || i.uses < i.max_uses);
  if (!list) return <Spinner />;
  return (
    <div className="space-y-1">
      {list.length === 0 && <div className="py-6 text-center text-sm text-slate-500">Приглашений пока нет</div>}
      {list.map((i) => (
        <div key={i.code} className={`flex items-center gap-3 rounded-lg px-3 py-2 ${active(i) ? 'bg-black/20' : 'opacity-50'}`}>
          <div className="min-w-0 flex-1">
            <div className="selectable font-mono text-sm text-slate-200">{i.code}</div>
            <div className="text-xs text-slate-500">
              {i.created_by ? `${profiles[i.created_by]?.display_name ?? '…'} · ` : ''}
              использований: {i.uses}
              {i.max_uses ? `/${i.max_uses}` : ''} · {i.expires_at ? `до ${formatMessageStamp(i.expires_at)}` : 'бессрочно'}
              {i.revoked && ' · отозвано'}
            </div>
          </div>
          {active(i) && (
            <>
              <button className="btn-ghost py-1 text-xs" onClick={() => void navigator.clipboard.writeText(inviteLink(i.code))}>
                Копировать
              </button>
              <button
                className="icon-btn hover:text-rose-300"
                title="Отозвать"
                onClick={async () => {
                  const { error } = await supabase.rpc('revoke_invite', { p_code: i.code });
                  if (error) toast.error('Ошибка', errorMessage(error));
                  void load();
                }}
              >
                <X className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function Bans({ serverId }: { serverId: string }) {
  const [list, setList] = useState<Ban[] | null>(null);
  const profiles = useProfiles((s) => s.byId);
  const load = async () => {
    const { data } = await supabase.from('server_bans').select('*').eq('server_id', serverId);
    const rows = (data ?? []) as Ban[];
    useProfiles.getState().ensure(rows.map((r) => r.user_id));
    setList(rows);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);
  if (!list) return <Spinner />;
  return (
    <div className="space-y-1">
      {list.length === 0 && <div className="py-6 text-center text-sm text-slate-500">Заблокированных пользователей нет</div>}
      {list.map((b) => (
        <div key={b.user_id} className="flex items-center gap-3 rounded-lg bg-black/20 px-3 py-2">
          <Avatar userId={b.user_id} size={30} />
          <div className="min-w-0 flex-1">
            <div className="text-sm text-white">{profiles[b.user_id]?.display_name ?? '…'}</div>
            {b.reason && <div className="text-xs text-slate-500">{b.reason}</div>}
          </div>
          <button
            className="btn-ghost py-1 text-xs"
            onClick={async () => {
              const { error } = await supabase.rpc('unban_member', { p_server: serverId, p_user: b.user_id });
              if (error) toast.error('Ошибка', errorMessage(error));
              else toast.success('Бан снят');
              void load();
            }}
          >
            Разбанить
          </button>
        </div>
      ))}
    </div>
  );
}

function Danger({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const server = useServers((s) => s.servers.find((x) => x.id === serverId))!;
  const members = useServers((s) => s.members[serverId]) ?? [];
  const profiles = useProfiles((s) => s.byId);
  const me = useAuth((s) => s.userId);
  const [target, setTarget] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-white/10 p-4">
        <div className="flex items-center gap-2 font-medium text-white">
          <Crown className="h-4 w-4 text-amber-300" /> Передать права владельца
        </div>
        <p className="mt-1 text-sm text-slate-400">Вы станете администратором, а выбранный участник — владельцем.</p>
        <div className="mt-3 flex gap-2">
          <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="" className="bg-base-900">Выберите участника</option>
            {members
              .filter((m) => m.user_id !== me)
              .map((m) => (
                <option key={m.user_id} value={m.user_id} className="bg-base-900">
                  {profiles[m.user_id]?.display_name ?? m.user_id}
                </option>
              ))}
          </select>
          <button
            className="btn-ghost shrink-0"
            disabled={!target || busy}
            onClick={async () => {
              setBusy(true);
              const { error } = await supabase.rpc('transfer_ownership', { p_server: serverId, p_user: target });
              setBusy(false);
              if (error) toast.error('Ошибка', errorMessage(error));
              else {
                toast.success('Права владельца переданы');
                await useServers.getState().loadServer(serverId);
                await useServers.getState().loadMembers(serverId);
              }
            }}
          >
            Передать
          </button>
        </div>
      </div>
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
        <div className="flex items-center gap-2 font-medium text-rose-200">
          <Trash2 className="h-4 w-4" /> Удалить сервер
        </div>
        <p className="mt-1 text-sm text-slate-400">Все каналы, сообщения и участники будут удалены навсегда. Введите название сервера для подтверждения.</p>
        <div className="mt-3 flex gap-2">
          <input className="input" placeholder={server.name} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
          <button
            className="btn-danger shrink-0"
            disabled={confirmName !== server.name || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await useServers.getState().deleteServer(serverId);
                onClose();
                useUi.getState().setView({ kind: 'home', tab: 'online' });
                toast.success('Сервер удалён');
              } catch (e) {
                toast.error('Ошибка', errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Удалить
          </button>
        </div>
      </div>
    </div>
  );
}

export function ServerSettingsModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const server = useServers((s) => s.servers.find((x) => x.id === serverId));
  const role = useServers((s) => s.myRoles[serverId]);
  const [tab, setTab] = useState<Tab>('overview');
  if (!server) return null;
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'overview', label: 'Обзор', show: true },
    { id: 'members', label: 'Участники и роли', show: roleAtLeast(role, 'moderator') },
    { id: 'invites', label: 'Приглашения', show: roleAtLeast(role, 'moderator') },
    { id: 'bans', label: 'Баны', show: roleAtLeast(role, 'moderator') },
    { id: 'danger', label: 'Опасная зона', show: role === 'owner' },
  ];
  return (
    <ModalShell open onClose={onClose} width="max-w-4xl">
      <div className="flex h-[78vh]">
        <aside className="w-56 shrink-0 border-r border-white/5 bg-black/20 p-3">
          <div className="mb-2 truncate px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{server.name}</div>
          {tabs
            .filter((t) => t.show)
            .map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`mb-0.5 w-full rounded-lg px-3 py-2 text-left text-sm transition ${tab === t.id ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'} ${
                  t.id === 'danger' ? 'text-rose-300' : ''
                }`}
              >
                {t.label}
              </button>
            ))}
        </aside>
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-xl font-semibold text-white">{tabs.find((t) => t.id === tab)?.label}</h2>
            <button className="icon-btn" onClick={onClose}>
              <X className="h-5 w-5" />
            </button>
          </div>
          {tab === 'overview' && <Overview serverId={serverId} />}
          {tab === 'members' && <Members serverId={serverId} />}
          {tab === 'invites' && <Invites serverId={serverId} />}
          {tab === 'bans' && <Bans serverId={serverId} />}
          {tab === 'danger' && <Danger serverId={serverId} onClose={onClose} />}
        </div>
      </div>
    </ModalShell>
  );
}
