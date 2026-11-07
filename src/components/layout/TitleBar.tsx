import { Download } from 'lucide-react';
import { LogoMark } from '@/components/ui/Logo';
import { useVoice } from '@/stores/voice';
import { useUpdates } from '@/stores/updates';
import { CallTimer } from '@/components/voice/CallTimer';
import { TONE_DOT, TONE_PILL, VOICE_STATUS_UI } from '@/components/voice/voiceStatusUi';
import { NetworkIndicator } from './NetworkIndicator';

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
        <span className={`ml-3 flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${TONE_PILL[VOICE_STATUS_UI[status].tone]}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[VOICE_STATUS_UI[status].tone]}`} />
          {status === 'connected' ? 'Голосовая связь' : VOICE_STATUS_UI[status].label} · {target.name}
          <CallTimer className="font-semibold" />
        </span>
      )}
      <NetworkIndicator />
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
