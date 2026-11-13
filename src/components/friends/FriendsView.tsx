import { useEffect, useState } from 'react';
import { Check, MessageSquare, MoreVertical, Search, ShieldOff, UserPlus, Users, X } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { otherUser, useSocial } from '@/stores/social';
import { useProfile } from '@/stores/profiles';
import { displayStatus, usePresence } from '@/stores/presence';
import { toast, useUi, type View } from '@/stores/ui';
import { Avatar } from '@/components/ui/Avatar';
import { UserBadge } from '@/components/ui/UserBadge';
import { EmptyState, Spinner } from '@/components/ui/primitives';
import { memberMenu, openDmWith } from '@/components/modals/memberMenu';
import { STATUS_LABEL, type Profile } from '@/lib/types';

type Tab = Extract<View, { kind: 'home' }>['tab'];

function PersonRow({ userId, subtitle, actions }: { userId: string; subtitle?: string; actions: JSX.Element }) {
  const p = useProfile(userId);
  const status = usePresence((s) => {
    const st = displayStatus(s, userId);
    return st === 'offline' ? undefined : st;
  });
  return (
    <div
      className="group flex items-center gap-3 rounded-xl border-t border-white/5 px-3 py-2.5 transition hover:bg-white/5"
      onContextMenu={(e) => {
        e.preventDefault();
        memberMenu(e, null, userId);
      }}
    >
      <Avatar userId={userId} size={38} showStatus />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-semibold text-white">{p?.display_name ?? '…'}</span>
          <UserBadge userId={userId} />
          <span className="hidden truncate text-sm text-slate-500 group-hover:inline">@{p?.username}</span>
        </div>
        <div className="truncate text-xs text-slate-400">{subtitle ?? (p?.custom_status || (status ? STATUS_LABEL[status] : 'Не в сети'))}</div>
      </div>
      <div className="flex gap-1.5">{actions}</div>
    </div>
  );
}

function RoundBtn({ title, onClick, children, danger }: { title: string; onClick: (e: React.MouseEvent) => void; children: JSX.Element; danger?: boolean }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded-full bg-black/30 text-slate-300 transition ${danger ? 'hover:text-rose-400' : 'hover:text-white'}`}
    >
      {children}
    </button>
  );
}

function AddFriend() {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Profile[]>([]);
  const me = useAuth((s) => s.userId);

  useEffect(() => {
    const t = setTimeout(async () => setFound(await useSocial.getState().searchUsers(query)), 300);
    return () => clearTimeout(t);
  }, [query]);

  const send = async (name: string) => {
    setBusy(true);
    setResult(null);
    try {
      const r = await useSocial.getState().sendRequest(name);
      const text: Record<string, string> = {
        sent: `Заявка пользователю @${name} отправлена!`,
        accepted: `Вы и @${name} теперь друзья!`,
        already_friends: 'Вы уже друзья',
        already_sent: 'Заявка уже отправлена',
      };
      setResult({ ok: true, text: text[r] ?? 'Готово' });
      setUsername('');
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8 p-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Добавить в друзья</h2>
        <p className="mt-1 text-sm text-slate-400">Введите username пользователя, чтобы отправить заявку.</p>
        <form
          className={`mt-4 flex items-center gap-2 rounded-xl border bg-black/30 p-2 ${result ? (result.ok ? 'border-emerald-500/50' : 'border-rose-500/50') : 'border-white/10'}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (username.trim()) void send(username.trim().replace(/^@/, '').toLowerCase());
          }}
        >
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="flex-1 bg-transparent px-2 text-sm outline-none placeholder:text-slate-500"
            placeholder="Например: realism_fan"
            autoFocus
          />
          <button className="btn-primary" disabled={busy || !username.trim()}>
            {busy && <Spinner />} Отправить заявку
          </button>
        </form>
        {result && <div className={`mt-2 text-sm ${result.ok ? 'text-emerald-400' : 'text-rose-400'}`}>{result.text}</div>}
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-300">Поиск пользователей</h3>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input className="input pl-9" placeholder="Имя или username" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="mt-3">
          {found
            .filter((p) => p.id !== me)
            .map((p) => (
              <PersonRow
                key={p.id}
                userId={p.id}
                subtitle={`@${p.username}`}
                actions={
                  <>
                    <RoundBtn title="Написать" onClick={() => void openDmWith(p.id)}>
                      <MessageSquare className="h-4 w-4" />
                    </RoundBtn>
                    <RoundBtn title="Добавить в друзья" onClick={() => void send(p.username)}>
                      <UserPlus className="h-4 w-4" />
                    </RoundBtn>
                  </>
                }
              />
            ))}
          {query.trim().length >= 2 && found.length === 0 && <div className="py-4 text-center text-sm text-slate-500">Никого не нашли</div>}
        </div>
      </div>
    </div>
  );
}

export function FriendsView() {
  const view = useUi((s) => s.view);
  const tab: Tab = view.kind === 'home' ? view.tab : 'online';
  const me = useAuth((s) => s.userId)!;
  const friendships = useSocial((s) => s.friendships);
  const blocked = useSocial((s) => s.blocked);
  const online = usePresence((s) => s.online);
  const setTab = (t: Tab) => useUi.getState().setView({ kind: 'home', tab: t });
  const social = useSocial.getState();

  const friends = friendships.filter((f) => f.status === 'accepted').map((f) => otherUser(f, me));
  const incoming = friendships.filter((f) => f.status === 'pending' && f.addressee_id === me);
  const outgoing = friendships.filter((f) => f.status === 'pending' && f.requester_id === me);
  const list = tab === 'online' ? friends.filter((id) => online[id]) : friends;

  const act = (p: Promise<unknown>, ok?: string) =>
    void p.then(
      () => ok && toast.success(ok),
      (e) => toast.error('Ошибка', (e as Error).message),
    );

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'online', label: 'В сети' },
    { id: 'all', label: 'Все' },
    { id: 'pending', label: 'Заявки', badge: incoming.length },
    { id: 'blocked', label: 'Заблокированные' },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-white/5 px-4">
        <Users className="h-5 w-5 text-slate-400" />
        <span className="mr-3 font-semibold text-white">Друзья</span>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm transition ${tab === t.id ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}`}
          >
            {t.label}
            {!!t.badge && <span className="rounded-full bg-rose-500 px-1.5 text-[11px] font-bold text-white">{t.badge}</span>}
          </button>
        ))}
        <button
          onClick={() => setTab('add')}
          className={`ml-1 rounded-lg px-2.5 py-1 text-sm font-medium transition ${tab === 'add' ? 'text-emerald-300' : 'bg-emerald-500/90 text-white hover:bg-emerald-500'}`}
        >
          Добавить в друзья
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'add' ? (
          <AddFriend />
        ) : (
          <div className="p-5">
            {(tab === 'online' || tab === 'all') && (
              <>
                <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  {tab === 'online' ? 'В сети' : 'Все друзья'} — {list.length}
                </div>
                {list.map((id) => (
                  <PersonRow
                    key={id}
                    userId={id}
                    actions={
                      <>
                        <RoundBtn title="Написать" onClick={() => void openDmWith(id)}>
                          <MessageSquare className="h-4 w-4" />
                        </RoundBtn>
                        <RoundBtn title="Ещё" onClick={(e) => memberMenu(e, null, id)}>
                          <MoreVertical className="h-4 w-4" />
                        </RoundBtn>
                      </>
                    }
                  />
                ))}
                {list.length === 0 && (
                  <EmptyState
                    icon={<Users className="h-7 w-7" />}
                    title={tab === 'online' ? 'Никого нет в сети' : 'Пока нет друзей'}
                    body="Добавьте друзей по username, чтобы общаться и звонить."
                    action={
                      <button className="btn-primary mt-2" onClick={() => setTab('add')}>
                        <UserPlus className="h-4 w-4" /> Добавить в друзья
                      </button>
                    }
                  />
                )}
              </>
            )}
            {tab === 'pending' && (
              <>
                <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Входящие — {incoming.length}</div>
                {incoming.map((f) => (
                  <PersonRow
                    key={f.id}
                    userId={f.requester_id}
                    subtitle="Входящая заявка"
                    actions={
                      <>
                        <RoundBtn title="Принять" onClick={() => act(social.respond(f.id, true), 'Заявка принята')}>
                          <Check className="h-4 w-4 text-emerald-400" />
                        </RoundBtn>
                        <RoundBtn title="Отклонить" danger onClick={() => act(social.respond(f.id, false))}>
                          <X className="h-4 w-4" />
                        </RoundBtn>
                      </>
                    }
                  />
                ))}
                <div className="mb-2 mt-6 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Исходящие — {outgoing.length}</div>
                {outgoing.map((f) => (
                  <PersonRow
                    key={f.id}
                    userId={f.addressee_id}
                    subtitle="Исходящая заявка"
                    actions={
                      <RoundBtn title="Отменить" danger onClick={() => act(social.respond(f.id, false))}>
                        <X className="h-4 w-4" />
                      </RoundBtn>
                    }
                  />
                ))}
              </>
            )}
            {tab === 'blocked' && (
              <>
                <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Заблокированные — {blocked.length}</div>
                {blocked.map((id) => (
                  <PersonRow
                    key={id}
                    userId={id}
                    subtitle="Заблокирован"
                    actions={
                      <RoundBtn title="Разблокировать" onClick={() => act(social.unblock(id), 'Пользователь разблокирован')}>
                        <ShieldOff className="h-4 w-4" />
                      </RoundBtn>
                    }
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
