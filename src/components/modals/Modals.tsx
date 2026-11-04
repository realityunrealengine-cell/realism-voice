import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Camera, Check, Copy, Hash, Lock, MessageSquare, UserPlus, Users, Volume2 } from 'lucide-react';
import { useUi, toast, type Modal } from '@/stores/ui';
import { useServers } from '@/stores/servers';
import { useAuth } from '@/stores/auth';
import { useSocial, otherUser } from '@/stores/social';
import { useProfile } from '@/stores/profiles';
import { usePresence } from '@/stores/presence';
import { supabase } from '@/lib/supabase';
import { errorMessage } from '@/lib/errors';
import { formatDay, inviteLink, plural } from '@/lib/format';
import { IMAGE_MIME } from '@/lib/media';
import { ROLE_LABEL, STATUS_LABEL } from '@/lib/types';
import { useMessages } from '@/stores/messages';
import { Avatar, ServerIcon } from '@/components/ui/Avatar';
import { UserBadge } from '@/components/ui/UserBadge';
import { Field, ModalShell, Select, Spinner, Switch } from '@/components/ui/primitives';
import { useInvitePreview } from '@/components/chat/InviteEmbed';
import { ScreenPicker } from '@/components/voice/ScreenPicker';
import { ServerSettingsModal } from './ServerSettingsModal';
import { ChannelSettingsModal } from './ChannelSettingsModal';
import { openDmWith, memberMenu } from './memberMenu';
import { ROLE_ICON } from '@/components/layout/MemberList';

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2 bg-black/20 px-6 py-4">{children}</div>;
}

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div> : null;
}

function CreateServerModal({ onClose }: { onClose: () => void }) {
  const name0 = useAuth((s) => s.profile?.display_name ?? '');
  const [name, setName] = useState(`Сервер ${name0}`.slice(0, 64));
  const [icon, setIcon] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { busy, error, run, setError } = useBusy();
  return (
    <ModalShell open onClose={onClose} title="Создать сервер" subtitle="Сервер — место для вас и ваших друзей. Иконку и название можно изменить позже.">
      <div className="space-y-5 px-6 pb-6 pt-3">
        <div className="flex justify-center">
          <button
            onClick={() => fileRef.current?.click()}
            className="relative flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border-2 border-dashed border-white/20 text-slate-400 hover:border-white/40"
          >
            {preview ? <img src={preview} alt="" className="h-full w-full object-cover" /> : <Camera className="h-7 w-7" />}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={IMAGE_MIME.join(',')}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > 5 * 1024 * 1024) return setError('Иконка должна быть не больше 5 МБ');
              setIcon(f);
              setPreview(URL.createObjectURL(f));
            }}
          />
        </div>
        <Field label="Название сервера">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus />
        </Field>
        <ErrorLine error={error} />
      </div>
      <Footer>
        <button className="btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button
          className="btn-primary"
          disabled={busy || name.trim().length < 2}
          onClick={() =>
            void run(async () => {
              const id = await useServers.getState().createServer(name, icon);
              onClose();
              useUi.getState().setView({ kind: 'server', serverId: id });
              toast.success('Сервер создан');
            })
          }
        >
          {busy && <Spinner />} Создать
        </button>
      </Footer>
    </ModalShell>
  );
}

function JoinServerModal({ code: initial, onClose }: { code?: string; onClose: () => void }) {
  const [input, setInput] = useState(initial ?? '');
  const code = (input.match(/([A-Za-z0-9]{6,16})\/?$/)?.[1] ?? '').trim();
  const [checked, setChecked] = useState<string | undefined>(initial);
  const preview = useInvitePreview(checked);
  const { busy, error, run } = useBusy();
  useEffect(() => {
    const t = setTimeout(() => setChecked(code || undefined), 400);
    return () => clearTimeout(t);
  }, [code]);
  return (
    <ModalShell open onClose={onClose} title="Присоединиться к серверу" subtitle="Введите приглашение — ссылку или код">
      <div className="space-y-4 px-6 pb-6 pt-3">
        <Field label="Приглашение" hint="Например: realismvoice://invite/Ab3dEf7hJk или Ab3dEf7hJk">
          <input className="input" value={input} onChange={(e) => setInput(e.target.value)} autoFocus />
        </Field>
        {checked && (
          <div className="rounded-xl bg-black/25 p-4">
            {preview.loading ? (
              <Spinner />
            ) : preview.data ? (
              <div className="flex items-center gap-3">
                <div className="h-12 w-12 overflow-hidden rounded-2xl">
                  <ServerIcon id={preview.data.server_id} name={preview.data.name} iconPath={preview.data.icon_path} />
                </div>
                <div>
                  <div className="font-semibold text-white">{preview.data.name}</div>
                  <div className="text-xs text-slate-400">
                    {preview.data.member_count} {plural(preview.data.member_count, 'участник', 'участника', 'участников')}
                    {preview.data.already_member && ' · вы уже участник'}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-sm text-slate-400">{preview.error}</div>
            )}
          </div>
        )}
        <ErrorLine error={error} />
      </div>
      <Footer>
        <button className="btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button
          className="btn-primary"
          disabled={busy || !preview.data}
          onClick={() =>
            void run(async () => {
              const id = await useServers.getState().joinServer(code);
              onClose();
              useUi.getState().setView({ kind: 'server', serverId: id });
              if (!preview.data?.already_member) toast.success(`Добро пожаловать на «${preview.data?.name}»!`);
            })
          }
        >
          {busy && <Spinner />} {preview.data?.already_member ? 'Перейти' : 'Вступить'}
        </button>
      </Footer>
    </ModalShell>
  );
}

function CreateChannelModal({ m, onClose }: { m: Extract<Modal, { type: 'createChannel' }>; onClose: () => void }) {
  const [type, setType] = useState<'text' | 'voice'>(m.channelType ?? 'text');
  const [name, setName] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const categories = useServers((s) => s.categories[m.serverId]) ?? [];
  const [categoryId, setCategoryId] = useState<string>(m.categoryId ?? '');
  const { busy, error, run } = useBusy();
  return (
    <ModalShell open onClose={onClose} title="Создать канал">
      <div className="space-y-4 px-6 pb-6 pt-3">
        <div className="space-y-2">
          <span className="label">Тип канала</span>
          {(['text', 'voice'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition ${type === t ? 'border-[color:var(--a2)] bg-white/10' : 'border-white/5 bg-black/20 hover:bg-white/5'}`}
            >
              {t === 'text' ? <Hash className="h-6 w-6 text-slate-300" /> : <Volume2 className="h-6 w-6 text-slate-300" />}
              <div>
                <div className="font-medium text-white">{t === 'text' ? 'Текстовый' : 'Голосовой'}</div>
                <div className="text-xs text-slate-400">{t === 'text' ? 'Сообщения, изображения, файлы и эмодзи' : 'Голос, видео и демонстрация экрана'}</div>
              </div>
            </button>
          ))}
        </div>
        <Field label="Название канала">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder={type === 'text' ? 'новый-канал' : 'Голосовая комната'} autoFocus />
        </Field>
        <Field label="Категория">
          <Select value={categoryId} onChange={setCategoryId} options={[{ value: '', label: 'Без категории' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]} />
        </Field>
        <label className="flex items-center justify-between rounded-xl bg-black/20 px-4 py-3">
          <span className="flex items-center gap-2 text-sm">
            <Lock className="h-4 w-4" /> Приватный канал
            <span className="text-xs text-slate-500">(модераторы и выбранные участники)</span>
          </span>
          <Switch checked={isPrivate} onChange={setPrivate} />
        </label>
        <ErrorLine error={error} />
      </div>
      <Footer>
        <button className="btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button
          className="btn-primary"
          disabled={busy || !name.trim()}
          onClick={() =>
            void run(async () => {
              const ch = await useServers.getState().createChannel(m.serverId, { name, type, categoryId: categoryId || null, isPrivate });
              onClose();
              if (ch.type === 'text') useUi.getState().openChannel(m.serverId, ch.id);
            })
          }
        >
          {busy && <Spinner />} Создать канал
        </button>
      </Footer>
    </ModalShell>
  );
}

function CategoryModal({ m, onClose }: { m: Extract<Modal, { type: 'createCategory' }>; onClose: () => void }) {
  const [name, setName] = useState(m.name ?? '');
  const { busy, error, run } = useBusy();
  return (
    <ModalShell open onClose={onClose} title={m.categoryId ? 'Переименовать категорию' : 'Создать категорию'}>
      <div className="space-y-4 px-6 pb-6 pt-3">
        <Field label="Название категории">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={48} autoFocus />
        </Field>
        <ErrorLine error={error} />
      </div>
      <Footer>
        <button className="btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button
          className="btn-primary"
          disabled={busy || !name.trim()}
          onClick={() =>
            void run(async () => {
              if (m.categoryId) await useServers.getState().renameCategory(m.categoryId, name);
              else await useServers.getState().createCategory(m.serverId, name);
              onClose();
            })
          }
        >
          {busy && <Spinner />} {m.categoryId ? 'Сохранить' : 'Создать'}
        </button>
      </Footer>
    </ModalShell>
  );
}

function InviteModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const server = useServers((s) => s.servers.find((x) => x.id === serverId));
  const [expires, setExpires] = useState('168');
  const [maxUses, setMaxUses] = useState('0');
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useBusy();
  const me = useAuth((s) => s.userId)!;
  const friendships = useSocial((s) => s.friendships);
  const friends = useMemo(() => friendships.filter((f) => f.status === 'accepted').map((f) => otherUser(f, me)), [friendships, me]);
  const [sent, setSent] = useState<Record<string, boolean>>({});

  const generate = () =>
    run(async () => {
      const { data, error: e } = await supabase.rpc('create_invite', {
        p_server: serverId,
        p_max_uses: maxUses === '0' ? null : Number(maxUses),
        p_expires_hours: expires === '0' ? null : Number(expires),
      });
      if (e) throw e;
      setCode(data as string);
    });

  useEffect(() => {
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expires, maxUses]);

  const sendTo = async (userId: string) => {
    if (!code) return;
    try {
      const dmId = await useSocial.getState().openDm(userId);
      await useMessages.getState().send({ kind: 'dm', id: dmId }, `Присоединяйся к серверу «${server?.name}»: ${inviteLink(code)}`, [], null);
      setSent((s) => ({ ...s, [userId]: true }));
    } catch (e) {
      toast.error('Не удалось отправить', (e as Error).message);
    }
  };

  return (
    <ModalShell open onClose={onClose} title={`Пригласить на «${server?.name ?? ''}»`} width="max-w-lg">
      <div className="space-y-5 px-6 pb-6 pt-3">
        {friends.length > 0 && (
          <div>
            <span className="label">Друзья</span>
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {friends.map((id) => (
                <FriendInviteRow key={id} userId={id} sent={!!sent[id]} disabled={!code} onSend={() => void sendTo(id)} />
              ))}
            </div>
          </div>
        )}
        <div>
          <span className="label">Ссылка-приглашение</span>
          <div className="flex gap-2">
            <input className="input font-mono text-xs" readOnly value={code ? inviteLink(code) : busy ? 'Создаём…' : ''} />
            <button
              className="btn-primary shrink-0"
              disabled={!code}
              onClick={() => {
                void navigator.clipboard.writeText(inviteLink(code!));
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'Скопировано' : 'Копировать'}
            </button>
          </div>
          {code && (
            <p className="mt-1.5 text-xs text-slate-500">
              Код: <span className="selectable font-mono text-slate-300">{code}</span> — друг может ввести его в окне «Присоединиться к серверу».
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Срок действия">
            <Select
              value={expires}
              onChange={setExpires}
              options={[
                { value: '1', label: '1 час' },
                { value: '24', label: '1 день' },
                { value: '168', label: '7 дней' },
                { value: '720', label: '30 дней' },
                { value: '0', label: 'Бессрочно' },
              ]}
            />
          </Field>
          <Field label="Лимит использований">
            <Select
              value={maxUses}
              onChange={setMaxUses}
              options={[
                { value: '0', label: 'Без лимита' },
                { value: '1', label: '1 раз' },
                { value: '5', label: '5 раз' },
                { value: '25', label: '25 раз' },
                { value: '100', label: '100 раз' },
              ]}
            />
          </Field>
        </div>
        <ErrorLine error={error} />
      </div>
    </ModalShell>
  );
}

function FriendInviteRow({ userId, sent, disabled, onSend }: { userId: string; sent: boolean; disabled: boolean; onSend: () => void }) {
  const p = useProfile(userId);
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5">
      <Avatar userId={userId} size={32} showStatus />
      <span className="flex-1 truncate text-sm text-slate-200">{p?.display_name ?? '…'}</span>
      <button className={sent ? 'btn-ghost py-1 text-emerald-300' : 'btn-ghost py-1'} disabled={disabled || sent} onClick={onSend}>
        {sent ? 'Отправлено' : 'Пригласить'}
      </button>
    </div>
  );
}

function InviteFriendModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const servers = useServers((s) => s.servers);
  const p = useProfile(userId);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const invite = async (serverId: string, name: string) => {
    setBusyId(serverId);
    try {
      const { data, error } = await supabase.rpc('create_invite', { p_server: serverId, p_max_uses: 1, p_expires_hours: 168 });
      if (error) throw error;
      const dmId = await useSocial.getState().openDm(userId);
      await useMessages.getState().send({ kind: 'dm', id: dmId }, `Присоединяйся к серверу «${name}»: ${inviteLink(data as string)}`, [], null);
      setDone((d) => ({ ...d, [serverId]: true }));
    } catch (e) {
      toast.error('Не удалось пригласить', errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };
  return (
    <ModalShell open onClose={onClose} title={`Пригласить ${p?.display_name ?? ''} на сервер`}>
      <div className="max-h-[50vh] space-y-1 overflow-y-auto px-6 pb-6 pt-3">
        {servers.map((s) => (
          <div key={s.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/5">
            <div className="h-9 w-9 overflow-hidden rounded-xl">
              <ServerIcon id={s.id} name={s.name} iconPath={s.icon_path} size={36} />
            </div>
            <span className="flex-1 truncate text-sm text-slate-200">{s.name}</span>
            <button className="btn-ghost py-1" disabled={!!busyId || done[s.id]} onClick={() => void invite(s.id, s.name)}>
              {busyId === s.id && <Spinner />} {done[s.id] ? 'Отправлено' : 'Пригласить'}
            </button>
          </div>
        ))}
        {servers.length === 0 && <div className="py-6 text-center text-sm text-slate-500">У вас пока нет серверов</div>}
      </div>
    </ModalShell>
  );
}

function ProfileModal({ userId, serverId, onClose }: { userId: string; serverId?: string; onClose: () => void }) {
  const p = useProfile(userId);
  const me = useAuth((s) => s.userId);
  const status = usePresence((s) => s.online[userId]);
  const member = useServers((s) => (serverId ? s.members[serverId]?.find((m) => m.user_id === userId) : undefined));
  const friendship = useSocial((s) => s.friendships.find((f) => f.requester_id === userId || f.addressee_id === userId));
  const servers = useServers((s) => s.servers);
  const allMembers = useServers((s) => s.members);
  const mutual = useMemo(() => servers.filter((sv) => allMembers[sv.id]?.some((m) => m.user_id === userId)), [servers, allMembers, userId]);
  if (!p) return null;
  const banner = p.accent_color ?? undefined;
  return (
    <ModalShell open onClose={onClose} width="max-w-sm">
      <div className="h-24 accent-bg" style={banner ? { background: banner } : undefined} />
      <div className="px-5 pb-5">
        <div className="-mt-12 mb-3 flex items-end justify-between">
          <div className="rounded-full ring-[6px] ring-base-900">
            <Avatar userId={userId} size={84} showStatus />
          </div>
          {userId !== me && (
            <div className="flex gap-2">
              <button className="btn-primary py-1.5" onClick={() => void openDmWith(userId)}>
                <MessageSquare className="h-4 w-4" /> Написать
              </button>
              {!friendship && (
                <button
                  className="btn-ghost py-1.5"
                  title="Добавить в друзья"
                  onClick={() =>
                    void useSocial.getState().sendRequest(p.username).then(
                      () => toast.success('Заявка отправлена'),
                      (e) => toast.error('Ошибка', e.message),
                    )
                  }
                >
                  <UserPlus className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
        </div>
        <div className="rounded-xl bg-black/30 p-4">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xl font-bold text-white">{member?.nickname || p.display_name}</span>
            <UserBadge userId={userId} />
          </div>
          <div className="text-sm text-slate-400">@{p.username}</div>
          {p.custom_status && <div className="mt-2 text-sm text-slate-300">{p.custom_status}</div>}
          <div className="mt-1 text-xs text-slate-500">{status ? STATUS_LABEL[status] : 'Не в сети'}</div>
          {p.bio && (
            <>
              <div className="my-3 h-px bg-white/10" />
              <div className="label">Обо мне</div>
              <div className="selectable whitespace-pre-wrap text-sm text-slate-300">{p.bio}</div>
            </>
          )}
          <div className="my-3 h-px bg-white/10" />
          <div className="label">В Realism Voice с</div>
          <div className="text-sm text-slate-300">{formatDay(p.created_at)}</div>
          {member && (
            <>
              <div className="label mt-3">Роль на сервере</div>
              <div className="flex items-center gap-1.5 text-sm text-slate-300">
                {ROLE_ICON[member.role]} {ROLE_LABEL[member.role]}
              </div>
            </>
          )}
          {mutual.length > 0 && userId !== me && (
            <div className="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
              <Users className="h-3.5 w-3.5" /> Общих серверов: {mutual.length}
            </div>
          )}
        </div>
        {userId !== me && (
          <button className="mt-3 w-full text-center text-xs text-slate-500 hover:text-slate-300" onClick={(e) => memberMenu(e, serverId ?? null, userId)}>
            Другие действия…
          </button>
        )}
      </div>
    </ModalShell>
  );
}

function ConfirmModal({ m, onClose }: { m: Extract<Modal, { type: 'confirm' }>; onClose: () => void }) {
  const { busy, error, run } = useBusy();
  return (
    <ModalShell open onClose={onClose} title={m.title}>
      <div className="space-y-3 px-6 pb-6 pt-2 text-sm text-slate-300">
        <div>{m.body}</div>
        <ErrorLine error={error} />
      </div>
      <Footer>
        <button className="btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button
          className={m.danger ? 'btn-danger' : 'btn-primary'}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await m.onConfirm();
              onClose();
            })
          }
        >
          {busy && <Spinner />} {m.confirmLabel}
        </button>
      </Footer>
    </ModalShell>
  );
}

export function Modals() {
  const modal = useUi((s) => s.modal);
  const close = useUi((s) => s.closeModal);
  if (!modal) return null;
  switch (modal.type) {
    case 'createServer':
      return <CreateServerModal onClose={close} />;
    case 'joinServer':
      return <JoinServerModal code={modal.code} onClose={close} />;
    case 'createChannel':
      return <CreateChannelModal m={modal} onClose={close} />;
    case 'createCategory':
      return <CategoryModal m={modal} onClose={close} />;
    case 'invite':
      return <InviteModal serverId={modal.serverId} onClose={close} />;
    case 'inviteFriend':
      return <InviteFriendModal userId={modal.userId} onClose={close} />;
    case 'profile':
      return <ProfileModal userId={modal.userId} serverId={modal.serverId} onClose={close} />;
    case 'serverSettings':
      return <ServerSettingsModal serverId={modal.serverId} onClose={close} />;
    case 'channelSettings':
      return <ChannelSettingsModal channelId={modal.channelId} onClose={close} />;
    case 'screenPicker':
      return <ScreenPicker onClose={close} />;
    case 'confirm':
      return <ConfirmModal m={modal} onClose={close} />;
  }
}
