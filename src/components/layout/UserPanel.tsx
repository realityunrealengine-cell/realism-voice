import { Headphones, HeadphoneOff, Mic, MicOff, Monitor, PhoneOff, RefreshCw, Settings, Signal, Video, VideoOff } from 'lucide-react';
import { TONE_TEXT, VOICE_STATUS_UI } from '@/components/voice/voiceStatusUi';
import { useConnectivity, useSyncView } from '@/stores/connectivity';
import { ConnectionQuality } from 'livekit-client';
import { useAuth } from '@/stores/auth';
import { useVoice } from '@/stores/voice';
import { useUi } from '@/stores/ui';
import { usePresence } from '@/stores/presence';
import { Avatar } from '@/components/ui/Avatar';
import { STATUS_LABEL, type PresenceStatus } from '@/lib/types';
import { StatusDot } from '@/components/ui/Avatar';
import { UserBadge } from '@/components/ui/UserBadge';
import { CallTimer } from '@/components/voice/CallTimer';
import { UpdatesButton } from '@/components/settings/UpdatesSection';
import { toast } from '@/stores/ui';

export const QUALITY: Record<ConnectionQuality, { label: string; color: string }> = {
  [ConnectionQuality.Excellent]: { label: 'Отличное соединение', color: 'text-emerald-400' },
  [ConnectionQuality.Good]: { label: 'Хорошее соединение', color: 'text-lime-300' },
  [ConnectionQuality.Poor]: { label: 'Плохое соединение', color: 'text-amber-400' },
  [ConnectionQuality.Lost]: { label: 'Соединение потеряно', color: 'text-rose-400' },
  [ConnectionQuality.Unknown]: { label: 'Качество неизвестно', color: 'text-slate-400' },
};

function VoiceStatus() {
  const status = useVoice((s) => s.status);
  const target = useVoice((s) => s.target);
  const error = useVoice((s) => s.error);
  const quality = useVoice((s) => s.quality);
  const camera = useVoice((s) => s.camera);
  const screen = useVoice((s) => s.screen);
  const v = useVoice.getState();
  if (!target && status !== 'error' && status !== 'lost') return null;
  const q = QUALITY[quality];
  const tone = VOICE_STATUS_UI[status].tone;
  const failed = status === 'error' || status === 'lost';
  return (
    <div className="border-b border-white/5 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Signal className={`h-4 w-4 ${status === 'connected' ? q.color : failed ? 'text-rose-400' : 'animate-pulse text-amber-400'}`} />
        <div className="min-w-0 flex-1">
          <div className={`flex items-baseline justify-between gap-2 text-sm font-semibold ${status === 'connected' ? 'text-emerald-400' : TONE_TEXT[tone]}`}>
            <span className="truncate">{status === 'connected' ? 'Голосовая связь' : VOICE_STATUS_UI[status].label}</span>
            <CallTimer className="shrink-0 text-xs" />
          </div>
          <button
            className="block max-w-full truncate text-xs text-slate-400 hover:underline"
            title={status === 'connected' ? q.label : error ?? ''}
            onClick={() => {
              if (target?.kind === 'channel') {
                useUi.getState().setView({ kind: 'server', serverId: target.serverId });
                useUi.getState().setVoiceViewOpen(true);
              } else if (target?.kind === 'dm') {
                useUi.getState().setView({ kind: 'dm', dmId: target.dmId });
                useUi.getState().setVoiceViewOpen(true);
              }
            }}
          >
            {failed ? error : target?.name}
          </button>
        </div>
        {failed && target && (
          <button className="icon-btn text-amber-200 hover:bg-white/10" title="Переподключиться" onClick={() => void v.retry()}>
            <RefreshCw className="h-4 w-4" />
          </button>
        )}
        <button className="icon-btn text-rose-300 hover:bg-rose-500/20" title="Отключиться" onClick={() => void v.leave()}>
          <PhoneOff className="h-4 w-4" />
        </button>
      </div>
      {status === 'connected' && (
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <button className={`btn-ghost py-1.5 ${camera ? 'text-emerald-300' : ''}`} onClick={() => void v.toggleCamera()}>
            {camera ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />} Камера
          </button>
          <button
            className={`btn-ghost py-1.5 ${screen ? 'text-emerald-300' : ''}`}
            onClick={() => (screen ? void v.stopScreen() : useUi.getState().openModal({ type: 'screenPicker' }))}
          >
            <Monitor className="h-4 w-4" /> Экран
          </button>
        </div>
      )}
    </div>
  );
}

export function UserPanel() {
  const profile = useAuth((s) => s.profile);
  const muted = useVoice((s) => s.muted);
  const deafened = useVoice((s) => s.deafened);
  // Связь с сервером (статусы, сообщения) — не голосовая связь: у голоса свой индикатор выше
  const sync = useSyncView();
  const voice = useVoice.getState();
  if (!profile) return null;

  const statusMenu = (e: React.MouseEvent) => {
    const set = (status: PresenceStatus) =>
      void useAuth
        .getState()
        .updateProfile({ status })
        .then(() => usePresence.getState().setStatus(status))
        .catch((err) => toast.error('Ошибка', err.message));
    useUi.getState().openContextMenu(e, [
      ...(['online', 'idle', 'dnd', 'invisible'] as PresenceStatus[]).map((s) => ({
        label: STATUS_LABEL[s],
        icon: <StatusDot status={s} className="h-2.5 w-2.5 ring-0" />,
        onClick: () => set(s),
      })),
      { separator: true, label: '' },
      { label: 'Изменить профиль', icon: <Settings />, onClick: () => useUi.getState().openSettings('profile') },
    ]);
  };

  return (
    <div className="bg-black/25">
      <VoiceStatus />
      <div className="border-b border-white/5 px-2 py-1">
        <UpdatesButton />
      </div>
      <div className="flex items-center gap-1 px-2 py-2">
        <button className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-white/5" onClick={statusMenu}>
          <Avatar userId={profile.id} size={34} showStatus />
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <span className="truncate text-sm font-semibold text-white">{profile.display_name}</span>
              <UserBadge userId={profile.id} tag={false} />
            </div>
            <div
              className={`truncate text-xs ${sync.state === 'offline' ? 'text-rose-300' : sync.state === 'syncing' ? 'text-amber-300' : 'text-slate-400'}`}
              title={sync.detail ?? undefined}
              onClick={(e) => {
                if (sync.state === 'ok') return;
                e.stopPropagation();
                useConnectivity.getState().openDiagnostics();
              }}
            >
              {sync.label ?? (profile.custom_status || `@${profile.username}`)}
            </div>
          </div>
        </button>
        <button
          className={`icon-btn ${muted ? 'text-rose-400' : ''}`}
          title={muted ? 'Включить микрофон' : 'Выключить микрофон'}
          onClick={() => voice.toggleMute()}
        >
          {muted ? <MicOff className="h-[18px] w-[18px]" /> : <Mic className="h-[18px] w-[18px]" />}
        </button>
        <button
          className={`icon-btn ${deafened ? 'text-rose-400' : ''}`}
          title={deafened ? 'Включить звук' : 'Отключить звук'}
          onClick={() => voice.toggleDeafen()}
        >
          {deafened ? <HeadphoneOff className="h-[18px] w-[18px]" /> : <Headphones className="h-[18px] w-[18px]" />}
        </button>
        <button className="icon-btn" title="Настройки" onClick={() => useUi.getState().openSettings()}>
          <Settings className="h-[18px] w-[18px]" />
        </button>
      </div>
    </div>
  );
}
