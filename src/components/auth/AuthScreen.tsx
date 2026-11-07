import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, AtSign, Eye, EyeOff, KeyRound, Lock, Mail, MailCheck, ShieldCheck, User } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '@/stores/auth';
import { GOOGLE_AUTH_ENABLED, supabase } from '@/lib/supabase';
import { AppError } from '@/lib/errors';
import { NETWORK_ERROR_RE } from '@/stores/ui';
import { useConnectivity } from '@/stores/connectivity';
import { Spinner } from '@/components/ui/primitives';
import { Wordmark } from '@/components/ui/Logo';

type Mode = 'login' | 'register' | 'confirm' | 'forgot' | 'forgotSent' | 'reset';

const USERNAME_RE = /^[a-z0-9_.]{3,32}$/;

function IconInput({
  icon,
  type = 'text',
  value,
  onChange,
  placeholder,
  autoComplete,
  autoFocus,
  right,
}: {
  icon: ReactNode;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoComplete?: string;
  autoFocus?: boolean;
  right?: ReactNode;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      <input
        className="input pl-10 pr-10"
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        spellCheck={false}
      />
      {right && <span className="absolute right-2 top-1/2 -translate-y-1/2">{right}</span>}
    </div>
  );
}

export function AuthScreen() {
  const status = useAuth((s) => s.status);
  const notice = useAuth((s) => s.notice);
  const setNotice = useAuth((s) => s.setNotice);
  const [mode, setMode] = useState<Mode>(status === 'recovery' ? 'reset' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usernameState, setUsernameState] = useState<'idle' | 'checking' | 'free' | 'taken'>('idle');

  useEffect(() => {
    if (status === 'recovery') setMode('reset');
  }, [status]);

  useEffect(() => {
    if (mode !== 'register' || !USERNAME_RE.test(username)) {
      setUsernameState('idle');
      return;
    }
    setUsernameState('checking');
    const t = setTimeout(async () => {
      const { data, error: e } = await supabase.rpc('username_available', { p_username: username });
      setUsernameState(e ? 'idle' : data ? 'free' : 'taken');
    }, 400);
    return () => clearTimeout(t);
  }, [username, mode]);

  const go = (m: Mode) => {
    setError(null);
    setNotice(null);
    setCode('');
    setMode(m);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const auth = useAuth.getState();
    if (mode === 'login') {
      void run(async () => {
        try {
          await auth.signIn(email, password);
        } catch (err) {
          // Аккаунт создан, но email не подтверждён — сразу показываем подтверждение и повторную отправку письма
          if (err instanceof AppError && err.code === 'email_not_confirmed') {
            go('confirm');
            setNotice('Email ещё не подтверждён. Введите код из письма или нажмите «Отправить письмо ещё раз».');
            return;
          }
          throw err;
        }
      });
    } else if (mode === 'register') {
      if (!USERNAME_RE.test(username)) return setError('Username: 3–32 символа, латиница в нижнем регистре, цифры, «_» и «.»');
      if (displayName.trim().length < 1) return setError('Укажите отображаемое имя');
      if (password.length < 8) return setError('Пароль должен быть не короче 8 символов');
      if (password !== password2) return setError('Пароли не совпадают');
      void run(async () => {
        const r = await auth.signUp(email, password, username, displayName || username);
        if (r === 'confirm') setMode('confirm');
      });
    } else if (mode === 'confirm') {
      void run(() => auth.verifyOtp(email, code, 'signup'));
    } else if (mode === 'forgot') {
      void run(async () => {
        await auth.sendReset(email);
        setMode('forgotSent');
      });
    } else if (mode === 'forgotSent') {
      void run(() => auth.verifyOtp(email, code, 'recovery'));
    } else if (mode === 'reset') {
      if (password.length < 8) return setError('Пароль должен быть не короче 8 символов');
      if (password !== password2) return setError('Пароли не совпадают');
      void run(() => auth.updatePassword(password));
    }
  };

  const pwToggle = (
    <button type="button" className="icon-btn h-7 w-7" onClick={() => setShowPw(!showPw)} tabIndex={-1}>
      {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );

  const titles: Record<Mode, [string, string]> = {
    login: ['С возвращением!', 'Войдите, чтобы продолжить общение'],
    register: ['Создать аккаунт', 'Присоединяйтесь к Realism Voice'],
    confirm: ['Подтвердите email', `Мы отправили письмо на ${email || 'вашу почту'}`],
    forgot: ['Восстановление пароля', 'Отправим ссылку для сброса на ваш email'],
    forgotSent: ['Проверьте почту', 'Откройте ссылку из письма в этом компьютере или введите код'],
    reset: ['Новый пароль', 'Придумайте новый пароль для аккаунта'],
  };

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="grid w-full max-w-5xl grid-cols-1 items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5 }}
          className="hidden lg:block"
        >
          <Wordmark />
          <h1 className="mt-10 text-5xl font-bold leading-[1.08] tracking-tight text-white">
            Говорите так,
            <br />
            будто вы <span className="accent-text">рядом</span>.
          </h1>
          <p className="mt-5 max-w-md text-base leading-relaxed text-slate-400">
            Голосовые каналы с низкой задержкой, демонстрация экрана, серверы для друзей и сообществ — из любой точки мира.
          </p>
          <div className="mt-8 grid max-w-md grid-cols-3 gap-3">
            {[
              ['WebRTC', 'голос и видео'],
              ['RLS', 'защита данных'],
              ['Realtime', 'мгновенно'],
            ].map(([a, b]) => (
              <div key={a} className="glass rounded-xl p-3">
                <div className="text-sm font-semibold text-white">{a}</div>
                <div className="text-xs text-slate-400">{b}</div>
              </div>
            ))}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          className="glass-strong mx-auto w-full max-w-md rounded-3xl p-8 shadow-glass"
        >
          <div className="mb-6 lg:hidden">
            <Wordmark />
          </div>
          <AnimatePresence mode="wait">
            <motion.form
              key={mode}
              onSubmit={submit}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.18 }}
              className="space-y-4"
            >
              <div className="mb-2">
                {mode !== 'login' && mode !== 'reset' && (
                  <button type="button" onClick={() => go('login')} className="mb-3 flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200">
                    <ArrowLeft className="h-3.5 w-3.5" /> Ко входу
                  </button>
                )}
                <h2 className="text-2xl font-bold text-white">{titles[mode][0]}</h2>
                <p className="mt-1 text-sm text-slate-400">{titles[mode][1]}</p>
              </div>

              {notice && <div className="rounded-xl border border-sky-400/20 bg-sky-400/10 px-3.5 py-2.5 text-sm text-sky-200">{notice}</div>}

              {(mode === 'login' || mode === 'register' || mode === 'forgot') && (
                <IconInput icon={<Mail />} type="email" value={email} onChange={setEmail} placeholder="Email" autoComplete="email" autoFocus />
              )}

              {mode === 'register' && (
                <>
                  <div>
                    <IconInput
                      icon={<AtSign />}
                      value={username}
                      onChange={(v) => setUsername(v.toLowerCase().replace(/\s/g, ''))}
                      placeholder="username (уникальный)"
                      autoComplete="username"
                    />
                    <div className="mt-1 h-4 pl-1 text-xs">
                      {usernameState === 'checking' && <span className="text-slate-500">Проверяем…</span>}
                      {usernameState === 'free' && <span className="text-emerald-400">Username свободен</span>}
                      {usernameState === 'taken' && <span className="text-rose-400">Username уже занят</span>}
                      {username && !USERNAME_RE.test(username) && (
                        <span className="text-slate-500">3–32 символа: a–z, 0–9, «_», «.»</span>
                      )}
                    </div>
                  </div>
                  <IconInput icon={<User />} value={displayName} onChange={setDisplayName} placeholder="Отображаемое имя" autoComplete="nickname" />
                </>
              )}

              {(mode === 'login' || mode === 'register' || mode === 'reset') && (
                <IconInput
                  icon={<Lock />}
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={setPassword}
                  placeholder={mode === 'reset' ? 'Новый пароль' : 'Пароль'}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  autoFocus={mode === 'reset'}
                  right={pwToggle}
                />
              )}
              {(mode === 'register' || mode === 'reset') && (
                <IconInput
                  icon={<ShieldCheck />}
                  type={showPw ? 'text' : 'password'}
                  value={password2}
                  onChange={setPassword2}
                  placeholder="Повторите пароль"
                  autoComplete="new-password"
                />
              )}

              {(mode === 'confirm' || mode === 'forgotSent') && (
                <>
                  <div className="flex items-start gap-3 rounded-xl bg-white/5 p-3.5 text-sm text-slate-300">
                    <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-indigo-300" />
                    <span>
                      Нажмите на ссылку в письме — Realism Voice откроется автоматически. Если в письме есть код подтверждения, можно ввести его ниже.
                    </span>
                  </div>
                  <IconInput icon={<KeyRound />} value={code} onChange={(v) => setCode(v.replace(/\D/g, '').slice(0, 10))} placeholder="Код из письма (необязательно)" />
                </>
              )}

              {error && (
                <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-rose-400/20 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-200">
                  {error}
                  {NETWORK_ERROR_RE.test(error) && (
                    <button type="button" className="mt-1.5 block text-xs font-semibold text-sky-300 hover:underline" onClick={() => useConnectivity.getState().openDiagnostics()}>
                      Диагностика подключения →
                    </button>
                  )}
                </motion.div>
              )}

              {mode === 'login' && (
                <div className="flex justify-end">
                  <button type="button" onClick={() => go('forgot')} className="text-xs text-slate-400 hover:text-indigo-300">
                    Забыли пароль?
                  </button>
                </div>
              )}

              <button
                type="submit"
                className="btn-primary w-full py-3"
                disabled={busy || ((mode === 'confirm' || mode === 'forgotSent') && code.length < 6)}
              >
                {busy && <Spinner />}
                {
                  {
                    login: 'Войти',
                    register: 'Зарегистрироваться',
                    confirm: 'Подтвердить код',
                    forgot: 'Отправить ссылку',
                    forgotSent: 'Подтвердить код',
                    reset: 'Сохранить пароль',
                  }[mode]
                }
              </button>

              {mode === 'confirm' && (
                <button
                  type="button"
                  className="btn-ghost w-full"
                  disabled={busy}
                  onClick={() => void run(async () => {
                    await useAuth.getState().resendConfirmation(email);
                    setNotice('Письмо отправлено повторно');
                  })}
                >
                  Отправить письмо ещё раз
                </button>
              )}

              {mode === 'login' && GOOGLE_AUTH_ENABLED && (
                <button type="button" className="btn-ghost w-full" disabled={busy} onClick={() => void run(() => useAuth.getState().signInWithGoogle())}>
                  <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
                    <path fill="#fff" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3Z" opacity=".9" />
                    <path fill="#fff" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z" opacity=".7" />
                    <path fill="#fff" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1A10 10 0 0 0 2 12c0 1.6.4 3.1 1.1 4.6L6.4 14Z" opacity=".5" />
                    <path fill="#fff" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10C7.2 7.7 9.4 6 12 6Z" opacity=".8" />
                  </svg>
                  Войти через Google
                </button>
              )}

              <div className="pt-1 text-center text-sm text-slate-400">
                {mode === 'login' && (
                  <>
                    Нет аккаунта?{' '}
                    <button type="button" onClick={() => go('register')} className="font-medium text-indigo-300 hover:text-indigo-200">
                      Зарегистрироваться
                    </button>
                  </>
                )}
                {mode === 'register' && (
                  <>
                    Уже есть аккаунт?{' '}
                    <button type="button" onClick={() => go('login')} className="font-medium text-indigo-300 hover:text-indigo-200">
                      Войти
                    </button>
                  </>
                )}
                {mode === 'reset' && (
                  <button type="button" onClick={() => void useAuth.getState().signOut().then(() => go('login'))} className="text-slate-400 hover:text-slate-200">
                    Отмена
                  </button>
                )}
              </div>
            </motion.form>
          </AnimatePresence>
        </motion.div>
      </div>
    </div>
  );
}
