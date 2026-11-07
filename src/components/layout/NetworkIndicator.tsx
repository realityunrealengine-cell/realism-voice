import { WifiOff, RefreshCw } from 'lucide-react';
import { useConnectivity, useSyncView } from '@/stores/connectivity';
import { useAuth } from '@/stores/auth';

/** Индикатор связи с сервером в заголовке окна: показывается только при проблемах (голос — отдельно) */
export function NetworkIndicator() {
  const resuming = useConnectivity((s) => s.resuming);
  const sync = useSyncView();
  const signedIn = useAuth((s) => s.status === 'signedIn');
  if (!signedIn) return null;
  if (sync.state === 'offline') {
    return (
      <button
        className="no-drag ml-3 flex items-center gap-1.5 rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] text-rose-300 hover:bg-rose-500/25"
        title={sync.detail ?? ''}
        onClick={() => useConnectivity.getState().openDiagnostics()}
      >
        <WifiOff className="h-3 w-3" /> Нет интернета
      </button>
    );
  }
  if (sync.state === 'syncing' || resuming) {
    return (
      <button
        className="no-drag ml-3 flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300 hover:bg-amber-500/25"
        title={sync.detail ?? 'Восстановление после сна…'}
        onClick={() => useConnectivity.getState().openDiagnostics()}
      >
        <RefreshCw className="h-3 w-3 animate-spin [animation-duration:2s]" /> Синхронизация с сервером…
      </button>
    );
  }
  return null;
}
