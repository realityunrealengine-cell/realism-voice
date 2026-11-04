import { useRef, useState } from 'react';
import { Camera, Image as ImageIcon } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { useSocial } from '@/stores/social';
import { toast, useUi } from '@/stores/ui';
import { supabase } from '@/lib/supabase';
import { errorMessage } from '@/lib/errors';
import { IMAGE_MIME, uploadPublicImage } from '@/lib/media';
import { Avatar } from '@/components/ui/Avatar';
import { UserBadge } from '@/components/ui/UserBadge';
import { ProfileBanner } from '@/components/ui/ProfileBanner';
import { Field, Select, Spinner, Switch } from '@/components/ui/primitives';
import { Card, Row } from './parts';

const USERNAME_RE = /^[a-z0-9_.]{3,32}$/;

export function AccountSection() {
  const profile = useAuth((s) => s.profile)!;
  const session = useAuth((s) => s.session);
  const [username, setUsername] = useState(profile.username);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const saveUsername = async () => {
    if (!USERNAME_RE.test(username)) return toast.error('Некорректный username', '3–32 символа: a–z, 0–9, «_», «.»');
    setBusy('username');
    try {
      await useAuth.getState().updateProfile({ username });
      toast.success('Username изменён');
    } catch (e) {
      toast.error('Не удалось изменить', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const savePassword = async () => {
    if (pw.length < 8) return toast.error('Пароль должен быть не короче 8 символов');
    if (pw !== pw2) return toast.error('Пароли не совпадают');
    setBusy('pw');
    try {
      await useAuth.getState().updatePassword(pw);
      setPw('');
      setPw2('');
      toast.success('Пароль изменён');
    } catch (e) {
      toast.error('Не удалось изменить пароль', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-center gap-4">
          <Avatar userId={profile.id} size={72} showStatus />
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-lg font-semibold text-white">{profile.display_name}</span>
              <UserBadge userId={profile.id} />
            </div>
            <div className="text-sm text-slate-400">@{profile.username}</div>
          </div>
          <div className="flex-1" />
          <button className="btn-primary" onClick={() => useUi.getState().openSettings('profile')}>
            Редактировать профиль
          </button>
        </div>
        <div className="mt-5 space-y-3 rounded-xl bg-black/25 p-4">
          <div>
            <div className="label">Email</div>
            <div className="text-sm text-slate-200">{session?.user.email}</div>
          </div>
          <div>
            <div className="label">Username</div>
            <div className="flex gap-2">
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} maxLength={32} />
              <button className="btn-ghost shrink-0" disabled={username === profile.username || busy === 'username'} onClick={() => void saveUsername()}>
                {busy === 'username' && <Spinner />} Сохранить
              </button>
            </div>
          </div>
        </div>
      </Card>
      <Card>
        <h3 className="mb-3 font-semibold text-white">Смена пароля</h3>
        <div className="grid grid-cols-2 gap-3">
          <input className="input" type="password" placeholder="Новый пароль" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
          <input className="input" type="password" placeholder="Повторите пароль" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
        </div>
        <div className="mt-3 flex justify-end">
          <button className="btn-primary" disabled={!pw || busy === 'pw'} onClick={() => void savePassword()}>
            {busy === 'pw' && <Spinner />} Изменить пароль
          </button>
        </div>
      </Card>
      <Card>
        <h3 className="font-semibold text-white">Сессия</h3>
        <p className="mt-1 text-sm text-slate-400">
          Токены сессии хранятся на этом компьютере в зашифрованном виде (Windows DPAPI) и автоматически обновляются.
        </p>
        <div className="mt-3 flex gap-2">
          <button className="btn-ghost" onClick={() => void supabase.auth.signOut({ scope: 'others' }).then(() => toast.success('Другие сессии завершены'))}>
            Выйти на других устройствах
          </button>
          <button className="btn-danger" onClick={() => void useAuth.getState().signOut()}>
            Выйти
          </button>
        </div>
      </Card>
    </div>
  );
}

export function ProfileSection() {
  const profile = useAuth((s) => s.profile)!;
  const [displayName, setDisplayName] = useState(profile.display_name);
  const [bio, setBio] = useState(profile.bio);
  const [customStatus, setCustomStatus] = useState(profile.custom_status);
  const [accent, setAccent] = useState(profile.accent_color ?? '#8b5cf6');
  const [useAccent, setUseAccent] = useState(!!profile.accent_color);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const save = async () => {
    setBusy(true);
    try {
      await useAuth.getState().updateProfile({
        display_name: displayName.trim(),
        bio,
        custom_status: customStatus,
        accent_color: useAccent ? accent : null,
      });
      toast.success('Профиль сохранён');
    } catch (e) {
      toast.error('Не удалось сохранить', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const uploadAvatar = async (file: File) => {
    setUploading(true);
    try {
      const old = profile.avatar_path;
      const path = await uploadPublicImage('avatars', profile.id, file);
      await useAuth.getState().updateProfile({ avatar_path: path });
      if (old) void supabase.storage.from('avatars').remove([old]);
      toast.success('Аватар обновлён');
    } catch (e) {
      toast.error('Не удалось загрузить аватар', errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="grid grid-cols-[1fr_280px] gap-6">
      <div className="space-y-4">
        <Field label="Отображаемое имя">
          <input className="input" value={displayName} maxLength={32} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Статус" hint="Например: «Играю в шахматы» — виден друзьям и участникам серверов">
          <input className="input" value={customStatus} maxLength={128} onChange={(e) => setCustomStatus(e.target.value)} />
        </Field>
        <Field label="Обо мне">
          <textarea className="input resize-none" rows={4} maxLength={190} value={bio} onChange={(e) => setBio(e.target.value)} />
        </Field>
        <div>
          <span className="label">Цвет профиля</span>
          <div className="flex items-center gap-3">
            <Switch checked={useAccent} onChange={setUseAccent} />
            <input type="color" value={accent} disabled={!useAccent} onChange={(e) => setAccent(e.target.value)} className="h-9 w-16 cursor-pointer rounded-lg bg-transparent disabled:opacity-40" />
          </div>
        </div>
        <div className="flex justify-end">
          <button className="btn-primary" disabled={busy || !displayName.trim()} onClick={() => void save()}>
            {busy && <Spinner />} Сохранить
          </button>
        </div>
      </div>
      <div>
        <span className="label">Предпросмотр</span>
        <div className="overflow-hidden rounded-2xl bg-black/30">
          <ProfileBanner path={profile.banner_path} accent={useAccent ? accent : null} />
          <div className="relative px-4 pb-4">
            <button className="group relative -mt-8 rounded-full ring-4 ring-base-900" onClick={() => fileRef.current?.click()} disabled={uploading}>
              <Avatar userId={profile.id} size={72} />
              <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 transition group-hover:opacity-100">
                {uploading ? <Spinner /> : <Camera className="h-5 w-5" />}
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={IMAGE_MIME.join(',')}
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadAvatar(f);
                e.target.value = '';
              }}
            />
            <div className="mt-2 flex items-center gap-1.5">
              <span className="truncate font-semibold text-white">{displayName || '…'}</span>
              <UserBadge userId={profile.id} />
            </div>
            <div className="text-xs text-slate-400">@{profile.username}</div>
            {customStatus && <div className="mt-2 text-sm text-slate-300">{customStatus}</div>}
            {bio && <div className="mt-2 whitespace-pre-wrap text-xs text-slate-400">{bio}</div>}
          </div>
        </div>
        <button className="btn-ghost mt-3 w-full" onClick={() => useUi.getState().openModal({ type: 'profileBanner' })}>
          <ImageIcon className="h-4 w-4" /> Изменить баннер
        </button>
        {profile.avatar_path && (
          <button
            className="mt-2 text-xs text-rose-300 hover:underline"
            onClick={() =>
              void useAuth
                .getState()
                .updateProfile({ avatar_path: null })
                .then(() => supabase.storage.from('avatars').remove([profile.avatar_path!]))
            }
          >
            Удалить аватар
          </button>
        )}
      </div>
    </div>
  );
}

export function PrivacySection() {
  const profile = useAuth((s) => s.profile)!;
  const blocked = useSocial((s) => s.blocked);
  const update = (patch: Parameters<ReturnType<typeof useAuth.getState>['updateProfile']>[0]) =>
    void useAuth
      .getState()
      .updateProfile(patch)
      .catch((e) => toast.error('Ошибка', e.message));
  return (
    <div>
      <Row title="Кто может писать мне в личные сообщения" desc="Проверяется на сервере: посторонние не смогут начать переписку">
        <div className="w-52">
          <Select
            value={profile.allow_dms}
            onChange={(v) => update({ allow_dms: v })}
            options={[
              { value: 'everyone', label: 'Все пользователи' },
              { value: 'friends', label: 'Только друзья' },
            ]}
          />
        </div>
      </Row>
      <Row title="Принимать заявки в друзья" desc="Если выключено, заявку смогут отправить только участники общих серверов">
        <Switch checked={profile.allow_friend_requests} onChange={(v) => update({ allow_friend_requests: v })} />
      </Row>
      <Row title="Заблокированные пользователи" desc={`Сейчас заблокировано: ${blocked.length}`}>
        <button
          className="btn-ghost"
          onClick={() => {
            useUi.getState().closeSettings();
            useUi.getState().setView({ kind: 'home', tab: 'blocked' });
          }}
        >
          Открыть список
        </button>
      </Row>
      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        Личные сообщения защищены политиками Row Level Security в базе данных: прочитать их могут только участники переписки. Вложения из личных сообщений
        хранятся в приватном хранилище и выдаются по временным подписанным ссылкам.
      </p>
    </div>
  );
}
