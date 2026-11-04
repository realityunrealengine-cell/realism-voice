import { CheckCircle2, AlertCircle, Download, RefreshCw, Shield } from 'lucide-react';
import type { UpdateState } from '../../../electron/shared';
import { useUpdates } from '@/stores/updates';
import { formatMessageStamp, formatSize } from '@/lib/format';
import { Spinner } from '@/components/ui/primitives';
import { useInCall } from '@/components/ui/UpdateNotice';
import { Card } from './parts';

function statusText(s: UpdateState): string {
  switch (s.phase) {
    case 'disabled':
      if (s.disabledReason === 'dev') return 'Обновления работают только в установленной версии приложения.';
      if (s.disabledReason === 'failed') return 'Модуль обновлений не запустился. Приложение продолжает работать, новую версию можно установить вручную.';
      return 'В этой сборке не настроен канал обновлений.';
    case 'idle':
      return 'Проверка обновлений ещё не выполнялась.';
    case 'checking':
      return 'Проверка обновлений…';
    case 'not-available':
      return 'Установлена последняя версия';
    case 'downloading':
      return 'Загрузка обновления…';
    case 'downloaded':
      return 'Обновление загружено и проверено.';
    case 'installing':
      return 'Запуск установки…';
    case 'error':
      return s.error ?? 'Не удалось проверить обновления.';
  }
}

function StatusIcon({ phase }: { phase: UpdateState['phase'] }) {
  if (phase === 'checking' || phase === 'installing') return <Spinner className="h-5 w-5 text-slate-300" />;
  if (phase === 'downloading') return <Download className="h-5 w-5 text-sky-300" />;
  if (phase === 'not-available' || phase === 'downloaded') return <CheckCircle2 className="h-5 w-5 text-emerald-400" />;
  if (phase === 'error') return <AlertCircle className="h-5 w-5 text-rose-400" />;
  return <AlertCircle className="h-5 w-5 text-slate-500" />;
}

export function UpdatesSection() {
  const s = useUpdates((st) => st.state);
  const inCall = useInCall();
  if (!s) return <div className="text-sm text-slate-400">Обновления доступны только в приложении для Windows.</div>;
  const { check, install } = useUpdates.getState();
  const busy = s.phase === 'checking' || s.phase === 'downloading' || s.phase === 'installing' || s.phase === 'disabled';
  const percent = s.progress ? Math.min(100, Math.max(0, s.progress.percent)) : 0;
  return (
    <div className="space-y-5">
      <Card>
        <div className="grid grid-cols-2 gap-y-2 text-sm">
          <span className="text-slate-400">Текущая версия</span>
          <span className="text-slate-200">{s.currentVersion}</span>
          <span className="text-slate-400">Доступная версия</span>
          <span className="text-slate-200">{s.availableVersion ?? '—'}</span>
        </div>
        <div className="mt-4 flex items-start gap-3 border-t border-white/5 pt-4">
          <div className="mt-0.5 shrink-0">
            <StatusIcon phase={s.phase} />
          </div>
          <div className="min-w-0 text-sm text-white">
            {statusText(s)}
            {s.error && s.phase !== 'error' && <div className="mt-0.5 text-xs text-rose-300">{s.error}</div>}
            {s.nextRetryAt && <div className="mt-0.5 text-xs text-slate-400">Повторная попытка: {formatMessageStamp(new Date(s.nextRetryAt).toISOString())}</div>}
            {s.lastCheckedAt && <div className="mt-0.5 text-xs text-slate-500">Последняя проверка: {formatMessageStamp(new Date(s.lastCheckedAt).toISOString())}</div>}
          </div>
        </div>

        {s.phase === 'downloading' && (
          <div className="mt-4">
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div className="accent-bg h-full rounded-full transition-[width] duration-300" style={{ width: `${percent}%` }} />
            </div>
            <div className="mt-1.5 flex justify-between text-xs tabular-nums text-slate-400">
              {s.progress ? (
                <>
                  <span>
                    {percent.toFixed(0)}% · {formatSize(s.progress.transferred)} из {formatSize(s.progress.total)}
                  </span>
                  <span>{formatSize(s.progress.bytesPerSecond)}/с</span>
                </>
              ) : (
                <span>Подключение к серверу…</span>
              )}
            </div>
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {s.phase === 'downloaded' && (
            <button className="btn-primary" disabled={inCall} onClick={() => void install()}>
              <RefreshCw className="h-4 w-4" /> Обновить и перезапустить
            </button>
          )}
          <button className="btn-ghost" disabled={busy} onClick={check}>
            Проверить обновления
          </button>
        </div>
        {s.phase === 'downloaded' && inCall && <p className="mt-2 text-xs text-amber-300">Идёт звонок. Перезапуск станет доступен после его завершения, связь не прервётся.</p>}
      </Card>

      {s.releaseNotes && (
        <Card>
          <div className="mb-2 text-sm font-medium text-white">Что нового в версии {s.availableVersion}</div>
          <div className="max-h-56 overflow-y-auto whitespace-pre-line break-words text-sm leading-relaxed text-slate-300">{s.releaseNotes}</div>
        </Card>
      )}

      {s.phase !== 'disabled' && (
        <Card className="flex items-start gap-3 text-sm text-slate-400">
          <Shield className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
          {s.signatureRequired
            ? 'Перед установкой проверяются подпись манифеста Realism Voice, контрольная сумма SHA-512 и цифровая подпись издателя.'
            : 'Перед установкой проверяются подпись манифеста Realism Voice и контрольная сумма SHA-512. Сертификат Windows пока не используется, поэтому при первой установке вручную SmartScreen может показать предупреждение.'}
        </Card>
      )}
    </div>
  );
}
