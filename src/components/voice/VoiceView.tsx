import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle, Expand, Headphones, HeadphoneOff, Mic, MicOff, Monitor, MonitorOff, PhoneOff, RefreshCw, Settings, Signal, Video, VideoOff, Volume2,
  MessageSquare, Radio,
} from 'lucide-react';
import { useVoice, type ParticipantView } from '@/stores/voice';
import { useUi } from '@/stores/ui';
import { useSettings } from '@/stores/settings';
import { usePresence } from '@/stores/presence';
import { useProfile } from '@/stores/profiles';
import { Avatar } from '@/components/ui/Avatar';
import { Slider, Spinner } from '@/components/ui/primitives';
import { UserBadge } from '@/components/ui/UserBadge';
import { QUALITY } from '@/components/layout/UserPanel';
import { CallTimer } from './CallTimer';
import { TONE_DOT, TONE_PILL, VOICE_STATUS_UI } from './voiceStatusUi';

function TrackVideo({ track, mirror, contain }: { track: MediaStreamTrack; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = new MediaStream([track]);
    return () => {
      el.srcObject = null;
    };
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted className={`h-full w-full ${contain ? 'object-contain' : 'object-cover'} ${mirror ? 'mirror' : ''}`} />;
}

function VolumePopover({ identity, onClose }: { identity: string; onClose: () => void }) {
  const vol = useSettings((s) => s.prefs.userVolumes[identity] ?? 100);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    setTimeout(() => window.addEventListener('mousedown', down), 0);
    return () => window.removeEventListener('mousedown', down);
  }, [onClose]);
  return (
    <div ref={ref} className="glass-strong absolute bottom-12 left-1/2 z-20 w-56 -translate-x-1/2 rounded-xl p-3 shadow-glass" onClick={(e) => e.stopPropagation()}>
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-300">
        <Volume2 className="h-3.5 w-3.5" /> Громкость пользователя
      </div>
      <Slider
        value={vol}
        min={0}
        max={200}
        step={5}
        format={(v) => `${v}%`}
        onChange={(v) => {
          useSettings.getState().setUserVolume(identity, v);
          useVoice.getState().applyVolumes();
        }}
      />
    </div>
  );
}

function Tile({ p, big, deafened }: { p: ParticipantView; big?: boolean; deafened?: boolean }) {
  const profile = useProfile(p.identity);
  const [vol, setVol] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const video = big && p.screen ? p.screen : p.camera;
  const isScreen = big && !!p.screen;
  const q = QUALITY[p.quality];
  return (
    <div
      ref={boxRef}
      onContextMenu={(e) => {
        if (p.isLocal) return;
        e.preventDefault();
        setVol(true);
      }}
      className={`group relative flex aspect-video items-center justify-center overflow-hidden rounded-2xl border bg-black/40 transition ${
        p.speaking ? 'border-emerald-400/80 shadow-[0_0_0_2px_rgba(52,211,153,0.5)]' : 'border-white/5'
      }`}
    >
      {video ? (
        <TrackVideo track={video} mirror={p.isLocal && !isScreen} contain={isScreen} />
      ) : (
        <div className="flex flex-col items-center gap-3">
          <Avatar userId={p.identity} size={big ? 112 : 80} speaking={p.speaking} />
        </div>
      )}
      <div className="absolute bottom-2 left-2 flex max-w-[80%] items-center gap-1.5 rounded-lg bg-black/60 px-2 py-1 text-xs text-white backdrop-blur">
        {p.micMuted ? <MicOff className="h-3.5 w-3.5 text-rose-400" /> : <Mic className={`h-3.5 w-3.5 ${p.speaking ? 'text-emerald-400' : 'text-slate-300'}`} />}
        {deafened && <HeadphoneOff className="h-3.5 w-3.5 text-rose-400" />}
        <span className="truncate">{profile?.display_name ?? p.name}{p.isLocal ? ' (вы)' : ''}</span>
        <UserBadge userId={p.identity} tag={false} />
        {isScreen && <span className="rounded bg-rose-500 px-1 text-[10px] font-bold">LIVE</span>}
      </div>
      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
        <span className={`rounded-lg bg-black/60 p-1.5 ${q.color}`} title={q.label}>
          <Signal className="h-3.5 w-3.5" />
        </span>
        {video && (
          <button className="rounded-lg bg-black/60 p-1.5 text-white" title="На весь экран" onClick={() => void boxRef.current?.requestFullscreen()}>
            <Expand className="h-3.5 w-3.5" />
          </button>
        )}
        {!p.isLocal && (
          <button className="rounded-lg bg-black/60 p-1.5 text-white" title="Громкость" onClick={() => setVol(true)}>
            <Volume2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {vol && <VolumePopover identity={p.identity} onClose={() => setVol(false)} />}
    </div>
  );
}

function ControlButton({ active, danger, title, onClick, children }: { active?: boolean; danger?: boolean; title: string; onClick: () => void; children: JSX.Element }) {
  return (
    <motion.button
      whileTap={{ scale: 0.92 }}
      title={title}
      onClick={onClick}
      className={`flex h-12 w-12 items-center justify-center rounded-full transition ${
        danger ? 'bg-rose-500 text-white hover:bg-rose-400' : active ? 'bg-white text-base-900' : 'bg-white/10 text-white hover:bg-white/20'
      }`}
    >
      {children}
    </motion.button>
  );
}

export function VoiceView() {
  const status = useVoice((s) => s.status);
  const target = useVoice((s) => s.target);
  const error = useVoice((s) => s.error);
  const notice = useVoice((s) => s.notice);
  const reconnectAttempt = useVoice((s) => s.reconnectAttempt);
  const participants = useVoice((s) => s.participants);
  const muted = useVoice((s) => s.muted);
  const deafened = useVoice((s) => s.deafened);
  const camera = useVoice((s) => s.camera);
  const screen = useVoice((s) => s.screen);
  const canSpeak = useVoice((s) => s.canSpeak);
  const pttMode = useSettings((s) => s.prefs.voiceMode === 'ptt');
  const pttKey = useSettings((s) => s.prefs.pttBinding.label);
  const transmitting = useVoice((s) => s.transmitting);
  const voicePresence = usePresence((s) => (target?.kind === 'channel' ? s.voice[target.serverId] : undefined));
  const [focus, setFocus] = useState<string | null>(null);
  const v = useVoice.getState();
  const ui = useUi.getState();

  if (!target && status !== 'error' && status !== 'lost') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-slate-400">
        <Radio className="h-10 w-10" />
        Вы не подключены к голосовому каналу
        {notice && <div className="max-w-md text-sm text-amber-200/80">{notice}</div>}
        <button className="btn-ghost" onClick={() => ui.setVoiceViewOpen(false)}>
          Вернуться к чату
        </button>
      </div>
    );
  }

  const deafenedIds = new Set((voicePresence ?? []).filter((m) => m.deafened).map((m) => m.user_id));
  const sharer = participants.find((p) => p.identity === focus && p.screen) ?? participants.find((p) => p.screen);

  return (
    <div className="flex h-full min-h-0 flex-col bg-black/20">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-white/5 px-4">
        <Volume2 className="h-5 w-5 text-emerald-400" />
        <span className="font-semibold text-white">{target?.name ?? 'Голосовая связь'}</span>
        {status === 'connected' && <span className="text-sm text-slate-500">· {participants.length} в канале</span>}
        <span className={`ml-1 flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${TONE_PILL[VOICE_STATUS_UI[status].tone]}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[VOICE_STATUS_UI[status].tone]}`} />
          {VOICE_STATUS_UI[status].label}
        </span>
        <CallTimer className="ml-1 rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-300" />
        <div className="flex-1" />
        <button className="icon-btn" title="Открыть чат" onClick={() => ui.setVoiceViewOpen(false)}>
          <MessageSquare className="h-[18px] w-[18px]" />
        </button>
      </header>

      <div className="relative min-h-0 flex-1 overflow-y-auto p-5">
        {status === 'error' || status === 'lost' ? (
          <div className="mx-auto mt-16 max-w-lg rounded-2xl border border-rose-500/20 bg-rose-500/10 p-6">
            <div className="mb-2 flex items-center gap-2 font-semibold text-rose-200">
              <AlertTriangle className="h-5 w-5" /> {status === 'lost' ? 'Соединение потеряно' : 'Голосовая связь не установлена'}
            </div>
            <p className="text-sm leading-relaxed text-rose-100/80">{error}</p>
            <div className="mt-4 flex gap-2">
              {target && (
                <button className="btn-primary" onClick={() => void v.retry()}>
                  <RefreshCw className="h-4 w-4" /> {status === 'lost' ? 'Переподключиться' : 'Повторить'}
                </button>
              )}
              <button className="btn-ghost" onClick={() => void v.leave()}>
                Закрыть
              </button>
            </div>
          </div>
        ) : status === 'connecting' ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-400">
            <Spinner className="h-8 w-8" />
            Подключение к голосовому серверу…
          </div>
        ) : sharer ? (
          <div className="flex h-full flex-col gap-3">
            <div className="min-h-0 flex-1">
              <div className="mx-auto h-full max-w-full" style={{ aspectRatio: '16 / 9' }}>
                <Tile p={sharer} big deafened={deafenedIds.has(sharer.identity)} />
              </div>
            </div>
            <div className="flex shrink-0 gap-3 overflow-x-auto pb-1">
              {participants.map((p) => (
                <div key={p.identity} className="w-48 shrink-0 cursor-pointer" onClick={() => p.screen && setFocus(p.identity)}>
                  <Tile p={p} deafened={deafenedIds.has(p.identity)} />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${participants.length <= 2 ? 360 : 240}px, 1fr))` }}
          >
            {participants.map((p) => (
              <Tile key={p.identity} p={p} deafened={deafenedIds.has(p.identity)} />
            ))}
          </div>
        )}
        {status === 'reconnecting' && (
          <div className="absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 rounded-full bg-amber-500/20 px-4 py-1.5 text-sm text-amber-200">
            <Spinner /> Переподключение…{reconnectAttempt > 0 ? ` попытка ${reconnectAttempt}` : ''}
          </div>
        )}
      </div>

      {(status === 'connected' || status === 'reconnecting') && (
        <div className="flex shrink-0 flex-col items-center gap-2 pb-5 pt-2">
          {!canSpeak && <div className="text-xs text-amber-300">В этом канале у вас режим слушателя</div>}
          {canSpeak && pttMode && (
            <div className={`text-xs ${transmitting ? 'text-emerald-300' : 'text-slate-500'}`}>
              Push-to-Talk: удерживайте «{pttKey}» {transmitting && '— вас слышно'}
            </div>
          )}
          <div className="glass flex items-center gap-3 rounded-full px-4 py-2.5 shadow-glass">
            <ControlButton title={muted ? 'Включить микрофон' : 'Выключить микрофон'} active={muted} onClick={() => v.toggleMute()}>
              {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
            </ControlButton>
            <ControlButton title={deafened ? 'Включить звук' : 'Отключить звук'} active={deafened} onClick={() => v.toggleDeafen()}>
              {deafened ? <HeadphoneOff className="h-5 w-5" /> : <Headphones className="h-5 w-5" />}
            </ControlButton>
            <ControlButton title={camera ? 'Выключить камеру' : 'Включить камеру'} active={camera} onClick={() => void v.toggleCamera()}>
              {camera ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
            </ControlButton>
            <ControlButton
              title={screen ? 'Остановить демонстрацию' : 'Демонстрация экрана'}
              active={screen}
              onClick={() => (screen ? void v.stopScreen() : ui.openModal({ type: 'screenPicker' }))}
            >
              {screen ? <MonitorOff className="h-5 w-5" /> : <Monitor className="h-5 w-5" />}
            </ControlButton>
            <ControlButton title="Настройки голоса" onClick={() => ui.openSettings('voice')}>
              <Settings className="h-5 w-5" />
            </ControlButton>
            <ControlButton danger title="Отключиться" onClick={() => void v.leave()}>
              <PhoneOff className="h-5 w-5" />
            </ControlButton>
          </div>
        </div>
      )}
    </div>
  );
}
