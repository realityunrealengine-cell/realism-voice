// Второй шаг входа: код из приложения-аутентификатора или резервный код.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { KeyRound, LifeBuoy, LogOut, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { AttemptLimiter, ServerFeatureMissing } from '@/lib/security';
import { Spinner } from '@/components/ui/primitives';
import { Wordmark } from '@/components/ui/Logo';

const limiter = new AttemptLimiter();

export function MfaScreen() {
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setInterval(() => setWait(limiter.wait()), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    input.current?.focus();
    setCode('');
    setError(null);
  }, [mode]);

  const submit = async (e?: FormEvent, typed?: string) => {
    e?.preventDefault();
    if (busy || limiter.wait() > 0) return;
    const value = (typed ?? code).trim();
    if (mode === 'totp' && !/^\d{6}$/.test(value.replace(/\s/g, ''))) return setError('Введите 6 цифр из приложения-аутентификатора');
    setBusy(true);
    setError(null);
    try {
      if (mode === 'totp') await useAuth.getState().verifyMfa(value);
      else await useAuth.getState().redeemRecovery(value);
      limiter.success();
    } catch (err) {
      if (!(err instanceof ServerFeatureMissing)) limiter.fail();
      setError((err as Error).message);
      setWait(limiter.wait());
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const locked = wait > 0;
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="glass w-full max-w-md rounded-3xl p-8 shadow-glass">
        <Wordmark />
        <div className="mt-8 flex items-center gap-3">
          <ShieldCheck className="h-6 w-6 text-emerald-300" />
          <h1 className="text-xl font-semibold text-white">Двухфакторная аутентификация</h1>
        </div>
        <p className="mt-2 text-sm text-slate-400">
          {mode === 'totp'
            ? 'Введите 6-значный код из приложения-аутентификатора (Google Authenticator, Aegis, 1Password и т. п.).'
            : 'Введите один из резервных кодов, сохранённых при включении 2FA. Код одноразовый; после входа 2FA нужно будет настроить заново.'}
        </p>
        <form onSubmit={(e) => void submit(e)} className="mt-5 space-y-3">
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              ref={input}
              className="input pl-10 text-center font-mono text-lg tracking-[0.3em]"
              inputMode={mode === 'totp' ? 'numeric' : 'text'}
              autoComplete="one-time-code"
              maxLength={mode === 'totp' ? 7 : 11}
              placeholder={mode === 'totp' ? '000000' : 'XXXXX-XXXXX'}
              value={code}
              onChange={(e) => {
                const v = mode === 'totp' ? e.target.value.replace(/[^\d]/g, '') : e.target.value.toUpperCase();
                setCode(v);
                if (mode === 'totp' && v.length === 6) void submit(undefined, v);
              }}
              disabled={busy || locked}
            />
          </div>
          {error && <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div>}
          {locked && <div className="text-sm text-amber-300">Слишком много неверных кодов. Повторите через {Math.ceil(wait / 1000)} с.</div>}
          <button className="btn-primary w-full justify-center" disabled={busy || locked || !code}>
            {busy && <Spinner />} Подтвердить
          </button>
        </form>
        <div className="mt-5 flex items-center justify-between text-sm">
          <button className="flex items-center gap-1.5 text-sky-300 hover:underline" onClick={() => setMode(mode === 'totp' ? 'recovery' : 'totp')}>
            <LifeBuoy className="h-4 w-4" /> {mode === 'totp' ? 'Нет доступа к приложению?' : 'Ввести код из приложения'}
          </button>
          <button className="flex items-center gap-1.5 text-slate-400 hover:text-white" onClick={() => void useAuth.getState().signOut()}>
            <LogOut className="h-4 w-4" /> Выйти
          </button>
        </div>
      </div>
    </div>
  );
}
