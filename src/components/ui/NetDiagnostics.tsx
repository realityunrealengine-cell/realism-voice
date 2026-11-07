import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, Copy, Loader2, RefreshCw, ShieldAlert, Stethoscope, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useConnectivity } from '@/stores/connectivity';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '@/lib/supabase';
import { toast } from '@/stores/ui';
import type { NetReport } from '../../../electron/shared';
import { verdictText } from '../../../electron/netVerdict';

/** Текст отчёта для отправки разработчику: без ключей, токенов и личных данных */
export function reportText(r: NetReport): string {
  const lines = [
    `Realism Voice ${r.appVersion} · ${r.platform}`,
    `Время проверки: ${r.at}`,
    `Сервер: ${r.host}`,
    `Прокси: ${r.proxy ?? 'нет данных'}`,
    `Итог: ${r.verdict}`,
    '',
    ...r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? ` — ${c.detail}` : ''} (${c.ms} мс)`),
  ];
  return lines.join('\n');
}

export function NetDiagnostics() {
  const open = useConnectivity((s) => s.diagnosticsOpen);
  const [report, setReport] = useState<NetReport | null>(null);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setFailed(null);
    // Параллельно пытаемся переподключиться — диагностика ничего не ломает
    void useConnectivity.getState().recover('diagnostics');
    try {
      if (!window.rv?.app.diagnoseNetwork) throw new Error('Диагностика доступна только в приложении');
      setReport(await window.rv.app.diagnoseNetwork(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY));
    } catch (e) {
      setFailed((e as Error)?.message?.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') || 'Не удалось выполнить проверку');
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setReport(null);
      void run();
    }
  }, [open, run]);

  const close = () => useConnectivity.getState().closeDiagnostics();
  const v = report ? verdictText(report.verdict, report.facts) : null;
  const tone = v?.severity === 'ok' ? 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100' : v?.severity === 'warn' ? 'border-amber-400/20 bg-amber-500/10 text-amber-100' : 'border-rose-400/20 bg-rose-500/10 text-rose-100';

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && close()}
        >
          <motion.div
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            className="glass-strong w-full max-w-lg rounded-2xl p-5 shadow-glass"
          >
            <div className="mb-4 flex items-center gap-2">
              <Stethoscope className="h-5 w-5 text-indigo-300" />
              <h2 className="flex-1 text-base font-semibold text-white">Диагностика подключения</h2>
              <button className="icon-btn" onClick={close} title="Закрыть">
                <X className="h-4 w-4" />
              </button>
            </div>

            {running && !report && (
              <div className="flex items-center gap-3 rounded-xl bg-white/5 px-4 py-6 text-sm text-slate-300">
                <Loader2 className="h-5 w-5 animate-spin" /> Проверяем путь до сервера… это займёт до 10 секунд
              </div>
            )}
            {failed && <div className="rounded-xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{failed}</div>}

            {report && v && (
              <>
                <div className={`mb-4 rounded-xl border px-4 py-3 ${tone}`}>
                  <div className="mb-1 flex items-center gap-2 font-semibold">
                    {v.severity === 'ok' ? <CheckCircle2 className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
                    {v.title}
                  </div>
                  <p className="text-sm opacity-90">{v.explain}</p>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm opacity-90">
                    {v.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                </div>
                <ul className="space-y-1.5 text-sm">
                  {report.checks.map((c) => (
                    <li key={c.id} className="flex items-center gap-2">
                      {c.ok ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" /> : <XCircle className="h-4 w-4 shrink-0 text-rose-400" />}
                      <span className="min-w-0 flex-1 truncate text-slate-200">{c.label}</span>
                      {c.detail && <span className="max-w-[45%] truncate text-xs text-slate-500" title={c.detail}>{c.detail}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              {report && (
                <button
                  className="btn-ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(reportText(report)).then(
                      () => toast.success('Отчёт скопирован', 'Отправьте его разработчику Realism Voice'),
                      () => toast.error('Не удалось скопировать отчёт'),
                    );
                  }}
                >
                  <Copy className="h-4 w-4" /> Скопировать отчёт
                </button>
              )}
              <button className="btn-primary" disabled={running} onClick={() => void run()}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Проверить снова
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
