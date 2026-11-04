import { Download } from 'lucide-react';
import { LogoMark } from '@/components/ui/Logo';
import { useVoice } from '@/stores/voice';
import { useUpdates } from '@/stores/updates';
import { CallTimer } from '@/components/voice/CallTimer';

// Перетаскиваемая область окна. Справа — системные кнопки (titleBarOverlay Electron).
export function TitleBar() {
  const status = useVoice((s) => s.status);
  const target = useVoice((s) => s.target);
  const updatePhase = useUpdates((s) => s.state?.phase);
  return (
    <div className="drag-region relative z-40 flex h-9 shrink-0 items-center gap-2 bg-[#070912]/90 pl-3 pr-[150px]">
      <LogoMark size={18} />
      <span className="text-xs font-semibold tracking-wide text-slate-300">Realism Voice</span>
      {target && status !== 'idle' && (
        <span
          className={`ml-3 flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${
            status === 'connected' ? 'bg-emerald-500/15 text-emerald-300' : status === 'error' ? 'bg-rose-500/15 text-rose-300' : 'bg-amber-500/15 text-amber-300'
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${status === 'connected' ? 'bg-emerald-400' : status === 'error' ? 'bg-rose-400' : 'animate-pulse bg-amber-400'}`} />
          {status === 'connected' ? 'Голосовая связь' : status === 'error' ? 'Ошибка связи' : 'Подключение…'} · {target.name}
          <CallTimer className="font-semibold" />
        </span>
      )}
      {(updatePhase === 'available' || updatePhase === 'downloaded') && (
        <button
          className="no-drag ml-auto flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/25"
          onClick={() => useUpdates.getState().setPanelOpen(true)}
        >
          <Download className="h-3 w-3" /> {updatePhase === 'available' ? 'Доступно обновление' : 'Обновление скачано'}
        </button>
      )}
    </div>
  );
}
