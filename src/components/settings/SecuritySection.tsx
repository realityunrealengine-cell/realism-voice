// «Безопасность»: двухфакторная аутентификация (TOTP), резервные коды, активные сессии и устройства.
import { useCallback, useEffect, useState } from 'react';
import { Copy, Download, KeyRound, LogOut, MonitorSmartphone, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { AttemptLimiter, security, ServerFeatureMissing, type SessionRow, type TotpEnrollment } from '@/lib/security';
import { useAuth } from '@/stores/auth';
import { toast, useUi } from '@/stores/ui';
import { Spinner } from '@/components/ui/primitives';
import { Card } from './parts';

const limiter = new AttemptLimiter();

function CodeInput({ value, onChange, onEnter }: { value: string; onChange: (v: string) => void; onEnter: () => void }) {
  return (
    <input
      className="input w-40 text-center font-mono tracking-[0.3em]"
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      placeholder="000000"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
      onKeyDown={(e) => e.key === 'Enter' && onEnter()}
    />
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = `Realism Voice — резервные коды 2FA (${new Date().toLocaleString('ru-RU')})\nКаждый код можно использовать один раз.\n\n${codes.join('\n')}\n`;
  return (
    <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-500/10 p-4">
      <div className="mb-2 text-sm font-semibold text-amber-200">Сохраните резервные коды</div>
      <p className="mb-3 text-xs text-amber-100/80">
        Они понадобятся, если телефон с приложением-аутентификатором будет потерян. Коды показываются только сейчас — на сервере хранятся лишь их хэши.
      </p>
      <div className="grid grid-cols-2 gap-1.5 font-mono text-sm text-white">
        {codes.map((c) => (
          <div key={c} className="selectable rounded bg-black/30 px-2 py-1 text-center">
            {c}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn-ghost py-1.5" onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success('Коды скопированы'))}>
          <Copy className="h-4 w-4" /> Копировать
        </button>
        <button
          className="btn-ghost py-1.5"
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
            a.download = 'realism-voice-recovery-codes.txt';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          }}
        >
          <Download className="h-4 w-4" /> Сохранить в файл
        </button>
        <div className="flex-1" />
        <button className="btn-primary py-1.5" onClick={onDone}>
          Я сохранил коды
        </button>
      </div>
    </div>
  );
}

function TwoFactor() {
  const [loading, setLoading] = useState(true);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enroll, setEnroll] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [remaining, setRemaining] = useState<number | null | 'missing'>(null);
  const [disabling, setDisabling] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { verified } = await security.factors();
      setFactorId(verified[0]?.id ?? null);
      if (verified[0]) {
        security
          .recoveryStatus()
          .then((r) => setRemaining(r.remaining))
          .catch((e) => setRemaining(e instanceof ServerFeatureMissing ? 'missing' : null));
      }
    } catch (e) {
      toast.error('2FA', (e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const guarded = async (fn: () => Promise<void>) => {
    const w = limiter.wait();
    if (w > 0) return toast.error('Слишком много неверных кодов', `Повторите через ${Math.ceil(w / 1000)} с`);
    setBusy(true);
    try {
      await fn();
      limiter.success();
    } catch (e) {
      if (/Неверный код/.test((e as Error).message)) limiter.fail();
      toast.error('Не получилось', (e as Error).message);
    } finally {
      setBusy(false);
      setCode('');
    }
  };

  const start = () =>
    guarded(async () => {
      setEnroll(await security.enrollTotp());
    });

  const confirm = () =>
    guarded(async () => {
      if (!enroll) return;
      await security.verify(enroll.factorId, code);
      setEnroll(null);
      toast.success('Двухфакторная аутентификация включена');
      try {
        setCodes((await security.recoveryGenerate()).codes);
      } catch (e) {
        toast.error('Резервные коды не созданы', (e as Error).message);
      }
      await refresh();
    });

  const regenerate = () =>
    guarded(async () => {
      setCodes((await security.recoveryGenerate()).codes);
      await refresh();
    });

  const disable = () =>
    guarded(async () => {
      if (!factorId) return;
      // Отключение требует сессии, подтверждённой вторым фактором
      await security.verify(factorId, code);
      await security.unenroll(factorId);
      setDisabling(false);
      setCodes(null);
      toast.success('Двухфакторная аутентификация отключена');
      await refresh();
    });

  if (loading) return <Card>{<Spinner />}</Card>;

  return (
    <Card>
      <div className="flex items-start gap-3">
        {factorId ? <ShieldCheck className="mt-0.5 h-6 w-6 text-emerald-300" /> : <ShieldAlert className="mt-0.5 h-6 w-6 text-amber-300" />}
        <div className="flex-1">
          <h3 className="font-semibold text-white">Двухфакторная аутентификация</h3>
          <p className="mt-1 text-sm text-slate-400">
            {factorId
              ? 'Включена. При входе на новом устройстве нужен код из приложения-аутентификатора.'
              : 'Защитите аккаунт: кроме пароля при входе понадобится 6-значный код из приложения-аутентификатора (TOTP).'}
          </p>
        </div>
        {!factorId && !enroll && (
          <button className="btn-primary" disabled={busy} onClick={() => void start()}>
            {busy && <Spinner />} Включить
          </button>
        )}
        {factorId && !disabling && (
          <button className="btn-danger" onClick={() => setDisabling(true)}>
            Отключить
          </button>
        )}
      </div>

      {enroll && (
        <div className="mt-4 flex gap-5 rounded-xl bg-black/25 p-4">
          <img src={enroll.qr} alt="QR-код для приложения-аутентификатора" className="h-40 w-40 shrink-0 rounded-lg bg-white p-2" />
          <div className="min-w-0 flex-1 text-sm">
            <ol className="list-decimal space-y-1 pl-5 text-slate-300">
              <li>Отсканируйте QR-код в приложении-аутентификаторе.</li>
              <li>Или введите ключ вручную:</li>
            </ol>
            <div className="selectable mt-1 break-all rounded bg-black/30 px-2 py-1 font-mono text-xs text-slate-200">{enroll.secret}</div>
            <div className="mt-3 text-slate-300">3. Введите код из приложения:</div>
            <div className="mt-1.5 flex gap-2">
              <CodeInput value={code} onChange={setCode} onEnter={() => void confirm()} />
              <button className="btn-primary" disabled={busy || code.length !== 6} onClick={() => void confirm()}>
                {busy && <Spinner />} Подтвердить
              </button>
              <button className="btn-ghost" onClick={() => setEnroll(null)}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {disabling && factorId && (
        <div className="mt-4 rounded-xl bg-black/25 p-4 text-sm">
          <div className="mb-2 text-slate-300">Для отключения введите текущий код из приложения:</div>
          <div className="flex gap-2">
            <CodeInput value={code} onChange={setCode} onEnter={() => void disable()} />
            <button className="btn-danger" disabled={busy || code.length !== 6} onClick={() => void disable()}>
              {busy && <Spinner />} Отключить 2FA
            </button>
            <button className="btn-ghost" onClick={() => setDisabling(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}

      {factorId && !codes && (
        <div className="mt-4 flex items-center gap-3 border-t border-white/5 pt-4 text-sm">
          <KeyRound className="h-4 w-4 text-slate-400" />
          <div className="flex-1 text-slate-300">
            {remaining === 'missing'
              ? 'Резервные коды станут доступны после обновления сервера (миграция 20261126000001 и функция account-security).'
              : remaining === null
                ? 'Резервные коды'
                : `Неиспользованных резервных кодов: ${remaining}`}
          </div>
          {remaining !== 'missing' && (
            <button className="btn-ghost py-1.5" disabled={busy} onClick={() => void regenerate()}>
              Создать новые коды
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

function describeAgent(ua: string | null): string {
  if (!ua) return 'Неизвестное устройство';
  const app = /RealismVoice\/([\d.]+)/.exec(ua)?.[1] ?? /Electron\/([\d.]+)/.exec(ua)?.[1];
  const os = /Windows NT 10/.test(ua) ? 'Windows' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [/Electron|RealismVoice/.test(ua) ? 'Realism Voice' : 'Браузер', app ? `(${app})` : '', os && `· ${os}`].filter(Boolean).join(' ');
}

function Sessions() {
  const [list, setList] = useState<SessionRow[] | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await security.sessions());
    } catch (e) {
      if (e instanceof ServerFeatureMissing) setMissing(e.message);
      else toast.error('Сессии', (e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = (s: SessionRow) =>
    useUi.getState().openModal({
      type: 'confirm',
      title: 'Завершить сессию?',
      body: <div className="text-sm text-slate-300">Устройство «{describeAgent(s.user_agent)}» будет отключено от аккаунта в течение часа (когда истечёт его токен доступа).</div>,
      confirmLabel: 'Завершить',
      danger: true,
      onConfirm: async () => {
        setBusy(s.id);
        try {
          await security.revoke(s.id);
          toast.success('Сессия завершена');
          await load();
        } catch (e) {
          toast.error('Не удалось', (e as Error).message);
        } finally {
          setBusy(null);
        }
      },
    });

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold text-white">Активные сессии и устройства</h3>
        <button
          className="btn-ghost py-1.5"
          onClick={() =>
            void supabase.auth
              .signOut({ scope: 'others' })
              .then(() => toast.success('Все другие сессии завершены'))
              .then(load)
          }
        >
          <LogOut className="h-4 w-4" /> Выйти на всех других
        </button>
      </div>
      {missing && <p className="text-sm text-slate-400">{missing}</p>}
      {!missing && !list && <Spinner />}
      {list?.map((s) => (
        <div key={s.id} className="flex items-center gap-3 border-t border-white/5 py-2.5 text-sm">
          <MonitorSmartphone className="h-5 w-5 shrink-0 text-slate-400" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-slate-200">
              {describeAgent(s.user_agent)}
              {s.is_current && <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">ЭТО УСТРОЙСТВО</span>}
              {s.aal === 'aal2' && <span className="ml-2 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300" title="Вход подтверждён вторым фактором">2FA</span>}
            </div>
            <div className="truncate text-xs text-slate-500">
              {s.ip ? `IP ${s.ip} · ` : ''}вход {new Date(s.created_at).toLocaleString('ru-RU')}
              {s.updated_at ? ` · активность ${new Date(s.updated_at).toLocaleString('ru-RU')}` : ''}
            </div>
          </div>
          {!s.is_current && (
            <button className="icon-btn text-rose-300 hover:bg-rose-500/15" title="Завершить сессию" disabled={busy === s.id} onClick={() => revoke(s)}>
              {busy === s.id ? <Spinner /> : <Trash2 className="h-4 w-4" />}
            </button>
          )}
        </div>
      ))}
    </Card>
  );
}

export function SecuritySection() {
  const email = useAuth((s) => s.session?.user.email);
  return (
    <div className="space-y-6">
      <TwoFactor />
      <Sessions />
      <p className="text-xs text-slate-500">
        Аккаунт: {email}. Защита от перебора: сервер Supabase Auth ограничивает частоту проверок кодов, резервные коды — не более 5 неверных попыток за 15
        минут, в приложении — нарастающая пауза после 5 ошибок.
      </p>
    </div>
  );
}
