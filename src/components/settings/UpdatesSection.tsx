import { CheckCircle2, AlertCircle, CircleArrowDown, Download, RefreshCw, Shield } from 'lucide-react';
import type { UpdateState } from '../../../electron/shared';
import { useUpdates } from '@/stores/updates';
import { formatMessageStamp, formatSize } from '@/lib/format';
import { ModalShell, Spinner } from '@/components/ui/primitives';
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
      return 'Установлена последняя версия Realism Voice';
    case 'available':
      return `Доступна новая версия ${s.availableVersion}`;
    case 'downloading':
      return 'Загрузка обновления…';
    case 'downloaded':
      return 'Обновление скачано';
    case 'installing':
      return 'Запуск установки…';
    case 'error':
      return s.error ?? 'Не удалось проверить обновления.';
  }
}

function StatusIcon({ phase }: { phase: UpdateState['phase'] }) {
  if (phase === 'checking' || phase === 'installing') return <Spinner className="h-5 w-5 text-slate-300" />;
  if (phase === 'downloading' || phase === 'available') return <Download className="h-5 w-5 text-sky-300" />;
  if (phase === 'not-available' || phase === 'downloaded') return <CheckCircle2 className="h-5 w-5 text-emerald-400" />;
  if (phase === 'error') return <AlertCircle className="h-5 w-5 text-rose-400" />;
  return <AlertCircle className="h-5 w-5 text-slate-500" />;
}

export function UpdatesSection() {
  const s = useUpdates((st) => st.state);
  const inCall = useInCall();
  if (!s) return <div className="text-sm text-slate-400">Обновления доступны только в приложении для Windows.</div>;
  const { check, download, install } = useUpdates.getState();
  const busy = s.phase === 'checking' || s.phase === 'downloading' || s.phase === 'installing' || s.phase === 'disabled';
  const canDownload = s.phase === 'available' || (s.phase === 'error' && s.availableVersion !== null);
  const percent = s.progress ? Math.min(100, Math.max(0, s.progress.percent)) : 0;
  const latest = s.availableVersion ?? (s.phase === 'not-available' ? s.currentVersion : '—');
  return (
    <div className="space-y-5">
      <Card>
        <div className="grid grid-cols-2 gap-y-2 text-sm">
          <span className="text-slate-400">Установленная версия</span>
          <span className="text-slate-200">{s.currentVersion}</span>
          <span className="text-slate-400">Последняя доступная версия</span>
          <span className="text-slate-200">{latest}</span>
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
              <span>
                {percent.toFixed(0)}%{s.progress ? ` · ${formatSize(s.progress.transferred)} из ${formatSize(s.progress.total)}` : ' · подключение к серверу…'}
              </span>
              {s.progress && <span>{formatSize(s.progress.bytesPerSecond)}/с</span>}
            </div>
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {canDownload && (
            <button className="btn-primary" onClick={download}>
              <Download className="h-4 w-4" /> Обновить
            </button>
          )}
          {s.phase === 'downloaded' && (
            <button className="btn-primary" disabled={inCall} onClick={() => void install()}>
              <RefreshCw className="h-4 w-4" /> Перезапустить и установить
            </button>
          )}
          <button className="btn-ghost" disabled={busy} onClick={check}>
            Проверить обновления
          </button>
        </div>
        {s.phase === 'downloaded' && inCall && <p className="mt-2 text-xs text-amber-300">Идёт звонок. Установка станет доступна после его завершения, связь не прервётся.</p>}
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

/** Панель обновлений: работает на любом экране, в том числе до входа в аккаунт */
export function UpdatesModal() {
  const open = useUpdates((s) => s.panelOpen);
  const close = () => useUpdates.getState().setPanelOpen(false);
  return (
    <ModalShell open={open} onClose={close} width="max-w-xl" title="Обновления Realism Voice">
      <div className="px-6 pb-6 pt-3">
        <UpdatesSection />
      </div>
    </ModalShell>
  );
}

/** Кнопка рядом с панелью профиля. Индикатор — есть новая версия, загрузка или готовая установка */
export function UpdatesButton() {
  const phase = useUpdates((s) => s.state?.phase);
  const percent = useUpdates((s) => s.state?.progress?.percent ?? 0);
  const version = useUpdates((s) => s.state?.availableVersion);
  if (!phase) return null;
  const pending = phase === 'available' || phase === 'downloading' || phase === 'downloaded';
  return (
    <button
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition hover:bg-white/5 ${pending ? 'text-emerald-300' : 'text-slate-400 hover:text-slate-200'}`}
      title="Обновления Realism Voice"
      onClick={() => useUpdates.getState().setPanelOpen(true)}
    >
      <span className="relative shrink-0">
        <CircleArrowDown className="h-4 w-4" />
        {pending && <span data-update-indicator className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-[#0b0d18]" />}
      </span>
      <span className="font-medium">Обновления</span>
      {phase === 'downloading' && <span className="ml-auto tabular-nums">{Math.min(100, percent).toFixed(0)}%</span>}
      {phase === 'available' && <span className="ml-auto">{version}</span>}
      {phase === 'downloaded' && <span className="ml-auto">Готово</span>}
    </button>
  );
}
