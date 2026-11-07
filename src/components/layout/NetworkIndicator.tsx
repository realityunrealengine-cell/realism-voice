import { WifiOff, RefreshCw } from 'lucide-react';
import { useConnectivity } from '@/stores/connectivity';
import { usePresence } from '@/stores/presence';
import { useAuth } from '@/stores/auth';

/** Индикатор сети в заголовке окна: показывается только при проблемах */
export function NetworkIndicator() {
  const online = useConnectivity((s) => s.online);
  const resuming = useConnectivity((s) => s.resuming);
  const connected = usePresence((s) => s.connected);
  const signedIn = useAuth((s) => s.status === 'signedIn');
  if (!signedIn) return null;
  if (!online) {
    return (
      <span className="ml-3 flex items-center gap-1.5 rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] text-rose-300" title="Windows сообщает, что подключения к интернету нет">
        <WifiOff className="h-3 w-3" /> Нет интернета
      </span>
    );
  }
  if (!connected || resuming) {
    return (
      <button
        className="no-drag ml-3 flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300 hover:bg-amber-500/25"
        title="Соединение с сервером восстанавливается. Нажмите, чтобы попробовать сейчас"
        onClick={() => void useConnectivity.getState().recover('manual')}
      >
        <RefreshCw className="h-3 w-3 animate-spin [animation-duration:2s]" /> Подключение к серверу…
      </button>
    );
  }
  return null;
}
