// Голосовая связь, видео и демонстрация экрана через LiveKit (WebRTC SFU).
// Токен доступа выдаёт Edge Function livekit-token после проверки прав в базе.
//
// Состояния: idle → connecting → connected ⇄ reconnecting → lost (соединение потеряно) / error (не удалось подключиться).
// Каждое подключение имеет «поколение» (ConnectionGeneration): если пользователь вышел или переключил канал,
// пока шло подключение, устаревшая комната разрывается, а не остаётся «призраком» в канале.
import { create } from 'zustand';
import {
  ConnectionQuality,
  DisconnectReason,
  LocalAudioTrack,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  Room,
  RoomEvent,
  ScreenSharePresets,
  Track,
  VideoPresets,
} from 'livekit-client';
import { supabase } from '@/lib/supabase';
import { functionErrorMessage } from '@/lib/errors';
import { VoiceGate } from '@/lib/voiceGate';
import { sounds } from '@/lib/sounds';
import { ConnectionGeneration, StaleConnectionError, nextReconnect } from '@/lib/reconnectPolicy';
import type { LiveParticipant } from '@/lib/voiceRoster';
import { useSettings } from './settings';
import { usePresence } from './presence';
import { useMessages } from './messages';
import { toast } from './ui';

export type VoiceTarget =
  | { kind: 'channel'; serverId: string; channelId: string; name: string }
  | { kind: 'dm'; dmId: string; peerId: string; name: string };

export interface ParticipantView {
  identity: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  micMuted: boolean;
  quality: ConnectionQuality;
  camera: Track | null;
  screen: Track | null;
  hasScreenAudio: boolean;
  joinedAt: number | null;
}

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'lost' | 'error';

interface VoiceState {
  status: VoiceStatus;
  target: VoiceTarget | null;
  error: string | null;
  /** Почему пользователь отключён без своего участия (показывается в голосовом окне) */
  notice: string | null;
  canSpeak: boolean;
  participants: ParticipantView[];
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  screen: boolean;
  transmitting: boolean;
  level: number;
  quality: ConnectionQuality;
  pttPressed: boolean;
  /** Начало разговора; при переподключении не сбрасывается */
  connectedAt: number | null;
  /** Номер попытки восстановления (для интерфейса) */
  reconnectAttempt: number;
  join: (target: VoiceTarget) => Promise<void>;
  leave: () => Promise<void>;
  retry: () => Promise<void>;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleCamera: () => Promise<void>;
  startScreen: (sourceId: string, withAudio: boolean) => Promise<void>;
  stopScreen: () => Promise<void>;
  setPtt: (pressed: boolean) => void;
  applyPrefs: () => Promise<void>;
  applyVolumes: () => void;
  /** Сеть или система вернулись (resume/online): проверить комнату */
  onConnectivityRestored: () => void;
}

let room: Room | null = null;
let gate: VoiceGate | null = null;
let audioCtx: AudioContext | null = null;
let audioHost: HTMLDivElement | null = null;
let lastLevelPush = 0;
const generation = new ConnectionGeneration();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectStartedAt = 0;
let networkWaiter: (() => void) | null = null;

function host(): HTMLDivElement {
  if (!audioHost) {
    audioHost = document.createElement('div');
    audioHost.style.display = 'none';
    audioHost.id = 'rv-audio-host';
    document.body.appendChild(audioHost);
  }
  return audioHost;
}

function captureOptions() {
  const p = useSettings.getState().prefs;
  return {
    deviceId: p.inputDeviceId && p.inputDeviceId !== 'default' ? p.inputDeviceId : undefined,
    echoCancellation: p.echoCancellation,
    noiseSuppression: p.noiseSuppression,
    autoGainControl: p.autoGainControl,
  };
}

function gateConfig() {
  const p = useSettings.getState().prefs;
  return {
    mode: p.voiceMode,
    thresholdDb: p.vadThreshold,
    inputGain: p.inputVolume / 100,
    pttReleaseMs: p.pttReleaseDelay,
  } as const;
}

function cameraResolution() {
  const q = useSettings.getState().prefs.cameraQuality;
  return q === '1080p' ? VideoPresets.h1080.resolution : q === '480p' ? VideoPresets.h540.resolution : VideoPresets.h720.resolution;
}

function screenPreset() {
  const q = useSettings.getState().prefs.screenQuality;
  return q === '1080p60' ? ScreenSharePresets.h1080fps30 : q === '720p' ? ScreenSharePresets.h720fps30 : ScreenSharePresets.h1080fps15;
}

function mediaErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'Нет доступа к микрофону или камере. Разрешите доступ в настройках Windows → Конфиденциальность.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Устройство не найдено. Выберите другое в настройках голоса.';
  if (name === 'NotReadableError') return 'Устройство занято другим приложением.';
  return (e as Error)?.message || 'Ошибка устройства';
}

function sameTarget(a: VoiceTarget | null, b: VoiceTarget | null): boolean {
  if (!a || !b) return false;
  if (a.kind === 'channel' && b.kind === 'channel') return a.channelId === b.channelId;
  if (a.kind === 'dm' && b.kind === 'dm') return a.dmId === b.dmId;
  return false;
}

/** Участники комнаты LiveKit в формате списка голосового канала */
export function liveParticipants(list: ParticipantView[]): LiveParticipant[] {
  return list.map((p) => ({ identity: p.identity, micMuted: p.micMuted, camera: !!p.camera, screen: !!p.screen, joinedAt: p.joinedAt }));
}

export const useVoice = create<VoiceState>((set, get) => {
  const sync = () => {
    if (!room) {
      set({ participants: [] });
      return;
    }
    const views: ParticipantView[] = [];
    const add = (p: Participant, isLocal: boolean) => {
      const cam = p.getTrackPublication(Track.Source.Camera);
      const scr = p.getTrackPublication(Track.Source.ScreenShare);
      const scrAudio = p.getTrackPublication(Track.Source.ScreenShareAudio);
      views.push({
        identity: p.identity,
        name: p.name || p.identity,
        isLocal,
        speaking: isLocal ? get().transmitting && !get().muted : p.isSpeaking,
        micMuted: isLocal ? get().muted || !get().canSpeak : !p.isMicrophoneEnabled,
        quality: p.connectionQuality,
        camera: cam && !cam.isMuted && cam.track ? cam.track : null,
        screen: scr && !scr.isMuted && scr.track ? scr.track : null,
        hasScreenAudio: !!scrAudio?.track,
        joinedAt: p.joinedAt ? p.joinedAt.getTime() : isLocal ? get().connectedAt : null,
      });
    };
    add(room.localParticipant, true);
    for (const p of room.remoteParticipants.values()) add(p, false);
    set({ participants: views, quality: room.localParticipant.connectionQuality });
  };

  const pushPresence = () => {
    const s = get();
    if (s.target?.kind === 'channel' && (s.status === 'connected' || s.status === 'reconnecting')) {
      usePresence.getState().trackVoice(s.target.serverId, {
        channel_id: s.target.channelId,
        muted: s.muted || !s.canSpeak,
        deafened: s.deafened,
        camera: s.camera,
        screen: s.screen,
      });
    } else {
      usePresence.getState().trackVoice(null, null);
    }
  };

  const applyRemoteVolume = (p: RemoteParticipant) => {
    const prefs = useSettings.getState().prefs;
    const userPct = prefs.userVolumes[p.identity] ?? 100;
    const v = get().deafened ? 0 : (userPct / 100) * (prefs.outputVolume / 100);
    p.setVolume(v, Track.Source.Microphone);
    p.setVolume(get().deafened ? 0 : prefs.outputVolume / 100, Track.Source.ScreenShareAudio);
  };

  const fetchToken = async (target: VoiceTarget) => {
    const body = target.kind === 'channel' ? { channel_id: target.channelId } : { dm_id: target.dmId };
    const { data, error } = await supabase.functions.invoke('livekit-token', { body });
    if (error) throw new Error(await functionErrorMessage(error));
    if (!data?.token || !data?.url) throw new Error('Сервер не вернул токен LiveKit');
    return data as { token: string; url: string; can_speak: boolean };
  };

  const publishMic = async () => {
    if (!room || !get().canSpeak) return;
    await room.localParticipant.setMicrophoneEnabled(true, captureOptions());
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.track as LocalAudioTrack | undefined;
    if (!track) return;
    gate = new VoiceGate(gateConfig());
    gate.onLevel = (db, open) => {
      const now = performance.now();
      if (open !== get().transmitting) {
        set({ transmitting: open });
        sync();
      }
      if (now - lastLevelPush > 100) {
        lastLevelPush = now;
        set({ level: db });
      }
    };
    await track.setAudioContext(audioCtx!);
    await track.setProcessor(gate);
    if (get().muted) await track.mute();
  };

  const clearReconnect = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (networkWaiter) window.removeEventListener('online', networkWaiter);
    networkWaiter = null;
  };

  const cleanupRoom = () => {
    gate = null;
    if (audioHost) audioHost.innerHTML = '';
    room?.removeAllListeners();
    room = null;
    window.rv?.ptt.setActive(false);
  };

  const updatePtt = () => {
    const prefs = useSettings.getState().prefs;
    const active = !!room && prefs.voiceMode === 'ptt';
    if (active) void useSettings.getState().setApp({ ptt: prefs.pttBinding });
    window.rv?.ptt.setActive(active);
  };

  /** Отключение не по воле пользователя, без автоматического повтора */
  const endExternally = (notice: string) => {
    generation.invalidate();
    clearReconnect();
    cleanupRoom();
    set({ status: 'idle', target: null, participants: [], connectedAt: null, camera: false, screen: false, transmitting: false, notice, reconnectAttempt: 0 });
    pushPresence();
    toast.info(notice);
  };

  const connect = async (target: VoiceTarget, gen: number) => {
    const ensureCurrent = async (r: Room | null) => {
      if (generation.isCurrent(gen)) return;
      if (r) {
        r.removeAllListeners();
        if (room === r) room = null;
        await r.disconnect().catch(() => undefined);
      }
      throw new StaleConnectionError();
    };

    const { token, url, can_speak } = await fetchToken(target);
    await ensureCurrent(null);
    audioCtx ??= new AudioContext({ latencyHint: 'interactive' });
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const prefs = useSettings.getState().prefs;
    const r = new Room({
      adaptiveStream: true,
      dynacast: true,
      webAudioMix: { audioContext: audioCtx },
      disconnectOnPageLeave: true,
      audioCaptureDefaults: captureOptions(),
      audioOutput: prefs.outputDeviceId && prefs.outputDeviceId !== 'default' ? { deviceId: prefs.outputDeviceId } : undefined,
      publishDefaults: { dtx: true, red: true, screenShareEncoding: screenPreset().encoding },
    });
    // Комната становится текущей до connect(): дорожки, подписанные во время подключения, должны прикрепиться
    room = r;

    r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
      if (room !== r) return;
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        el.dataset.identity = participant.identity;
        host().appendChild(el);
        applyRemoteVolume(participant);
      }
      sync();
    });
    r.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      track.detach().forEach((el) => el.remove());
      if (room === r) sync();
    });
    r.on(RoomEvent.ParticipantConnected, (p) => {
      if (room !== r) return;
      sounds.join();
      applyRemoteVolume(p);
      sync();
    });
    r.on(RoomEvent.ParticipantDisconnected, () => {
      if (room !== r) return;
      sounds.leave();
      sync();
    });
    for (const ev of [
      RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished,
      RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.ActiveSpeakersChanged, RoomEvent.ConnectionQualityChanged,
      RoomEvent.ParticipantNameChanged,
    ] as const) {
      r.on(ev, () => room === r && sync());
    }
    r.on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (room !== r) return;
      if (pub.source === Track.Source.ScreenShare) {
        set({ screen: false });
        pushPresence();
      }
      if (pub.source === Track.Source.Camera) {
        set({ camera: false });
        pushPresence();
      }
    });
    // Короткие сбои LiveKit восстанавливает сам — показываем «Переподключение», присутствие сохраняем
    r.on(RoomEvent.Reconnecting, () => room === r && set({ status: 'reconnecting' }));
    r.on(RoomEvent.Reconnected, () => {
      if (room !== r) return;
      set({ status: 'connected', reconnectAttempt: 0 });
      sync();
      pushPresence();
    });
    r.on(RoomEvent.MediaDevicesError, (e) => toast.error('Ошибка устройства', mediaErrorMessage(e)));
    r.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (room !== r || !generation.isCurrent(gen)) return;
      cleanupRoom();
      if (reason === DisconnectReason.CLIENT_INITIATED) return;
      if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
        endExternally('Вы подключились к голосовой связи с другого устройства — здесь соединение закрыто');
        return;
      }
      if (reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED) {
        endExternally('Вы отключены от голосового канала');
        return;
      }
      startReconnect(target);
    });

    await r.connect(url, token, { autoSubscribe: true });
    await ensureCurrent(r);
    set({ canSpeak: !!can_speak });
    await r.startAudio().catch(() => undefined);
    try {
      await publishMic();
    } catch (e) {
      toast.error('Микрофон недоступен', mediaErrorMessage(e));
      set({ muted: true });
    }
    await ensureCurrent(r);
    for (const p of r.remoteParticipants.values()) applyRemoteVolume(p);
    sync();
  };

  const giveUp = () => {
    clearReconnect();
    generation.invalidate();
    cleanupRoom();
    set({
      status: 'lost',
      error: 'Соединение с голосовым сервером потеряно. Проверьте интернет и нажмите «Переподключиться».',
      participants: [],
      connectedAt: null,
      camera: false,
      screen: false,
      transmitting: false,
      reconnectAttempt: 0,
    });
    // Окончательно потерянное соединение — убираем себя из списка участников у остальных
    pushPresence();
  };

  const scheduleAttempt = (target: VoiceTarget) => {
    const attempt = get().reconnectAttempt;
    const d = nextReconnect(attempt, reconnectStartedAt, Date.now(), navigator.onLine);
    if (d.action === 'give-up') {
      giveUp();
      return;
    }
    if (d.action === 'wait-network') {
      networkWaiter = () => {
        clearReconnect();
        scheduleAttempt(target);
      };
      window.addEventListener('online', networkWaiter);
      reconnectTimer = setTimeout(() => {
        clearReconnect();
        giveUp();
      }, d.delayMs);
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!sameTarget(get().target, target) || get().status !== 'reconnecting') return;
      const gen = generation.next();
      set({ reconnectAttempt: attempt + 1 });
      connect(target, gen)
        .then(() => {
          if (!generation.isCurrent(gen)) return;
          set({ status: 'connected', error: null, reconnectAttempt: 0 });
          updatePtt();
          pushPresence();
        })
        .catch((e) => {
          if (e instanceof StaleConnectionError || !generation.isCurrent(gen)) return;
          const failed = room;
          cleanupRoom();
          void failed?.disconnect().catch(() => undefined);
          scheduleAttempt(target);
        });
    }, d.delayMs);
  };

  const startReconnect = (target: VoiceTarget) => {
    clearReconnect();
    reconnectStartedAt = Date.now();
    set({ status: 'reconnecting', reconnectAttempt: 0, camera: false, screen: false, transmitting: false });
    sync();
    // Присутствие оставляем: при быстром восстановлении у других не будет «мигания»
    scheduleAttempt(target);
  };

  return {
    status: 'idle',
    target: null,
    error: null,
    notice: null,
    canSpeak: true,
    participants: [],
    muted: false,
    deafened: false,
    camera: false,
    screen: false,
    transmitting: false,
    level: -100,
    quality: ConnectionQuality.Unknown,
    pttPressed: false,
    connectedAt: null,
    reconnectAttempt: 0,

    join: async (target) => {
      const s = get();
      if (sameTarget(s.target, target) && (s.status === 'connected' || s.status === 'connecting' || s.status === 'reconnecting')) return;
      if (room || s.target) await get().leave();
      const gen = generation.next();
      set({ status: 'connecting', target, error: null, notice: null, camera: false, screen: false, transmitting: false, connectedAt: null, reconnectAttempt: 0 });
      pushPresence();
      try {
        await connect(target, gen);
        if (!generation.isCurrent(gen)) return;
        set({ status: 'connected', connectedAt: Date.now() });
        sync();
        sounds.join();
        updatePtt();
        pushPresence();
        // Звонок в ЛС: если собеседника ещё нет в комнате — отправляем уведомление о звонке
        if (target.kind === 'dm' && room && room.remoteParticipants.size === 0) {
          void useMessages.getState().send({ kind: 'dm', id: target.dmId }, '', [], null, 'call').catch(() => undefined);
        }
      } catch (e) {
        if (e instanceof StaleConnectionError || !generation.isCurrent(gen)) return;
        const msg = e instanceof Error ? e.message : String(e);
        generation.invalidate();
        const r = room;
        cleanupRoom();
        await r?.disconnect().catch(() => undefined);
        set({ status: 'error', error: msg, participants: [], connectedAt: null });
        pushPresence();
      }
    },

    leave: async () => {
      generation.invalidate();
      clearReconnect();
      const r = room;
      const wasConnected = !!r;
      cleanupRoom();
      set({ status: 'idle', target: null, participants: [], camera: false, screen: false, transmitting: false, error: null, connectedAt: null, reconnectAttempt: 0 });
      pushPresence();
      if (r) {
        if (wasConnected) sounds.leave();
        await r.disconnect().catch(() => undefined);
      }
    },

    retry: async () => {
      const t = get().target;
      if (!t) return;
      clearReconnect();
      generation.invalidate();
      const r = room;
      cleanupRoom();
      await r?.disconnect().catch(() => undefined);
      set({ status: 'idle' });
      await get().join(t);
    },

    toggleMute: () => {
      const muted = !get().muted;
      // Включение микрофона снимает и «оглушение»
      set({ muted, deafened: muted ? get().deafened : false });
      if (!muted) get().applyVolumes();
      muted ? sounds.mute() : sounds.unmute();
      const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (pub?.track) void (muted ? pub.mute() : pub.unmute());
      else if (!muted && room && get().canSpeak) void publishMic().catch((e) => toast.error('Микрофон недоступен', mediaErrorMessage(e)));
      sync();
      pushPresence();
    },

    toggleDeafen: () => {
      const deafened = !get().deafened;
      set({ deafened, muted: deafened ? true : get().muted });
      deafened ? sounds.mute() : sounds.unmute();
      const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (pub?.track && deafened) void pub.mute();
      get().applyVolumes();
      sync();
      pushPresence();
    },

    toggleCamera: async () => {
      if (!room) return;
      const on = !get().camera;
      try {
        const deviceId = useSettings.getState().prefs.videoDeviceId || undefined;
        await room.localParticipant.setCameraEnabled(on, { deviceId, resolution: cameraResolution() });
        set({ camera: on });
      } catch (e) {
        toast.error('Камера недоступна', mediaErrorMessage(e));
        set({ camera: false });
      }
      sync();
      pushPresence();
    },

    startScreen: async (sourceId, withAudio) => {
      if (!room) return;
      try {
        await window.rv?.screen.select(sourceId, withAudio);
        const preset = screenPreset();
        await room.localParticipant.setScreenShareEnabled(
          true,
          { audio: withAudio, resolution: preset.resolution, contentHint: 'detail', systemAudio: withAudio ? 'include' : 'exclude' },
          { screenShareEncoding: preset.encoding },
        );
        set({ screen: true });
      } catch (e) {
        toast.error('Не удалось начать демонстрацию', (e as Error)?.message);
        set({ screen: false });
      }
      sync();
      pushPresence();
    },

    stopScreen: async () => {
      if (!room) return;
      await room.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
      set({ screen: false });
      sync();
      pushPresence();
    },

    setPtt: (pressed) => {
      if (get().pttPressed === pressed) return;
      set({ pttPressed: pressed });
      gate?.setPtt(pressed);
    },

    applyPrefs: async () => {
      const prefs = useSettings.getState().prefs;
      gate?.setConfig(gateConfig());
      updatePtt();
      if (!room) return;
      get().applyVolumes();
      try {
        await room.switchActiveDevice('audiooutput', prefs.outputDeviceId || 'default');
      } catch {
        /* устройство вывода может не поддерживаться */
      }
      const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
      if (track) {
        const opts = captureOptions();
        const cur = track.mediaStreamTrack.getSettings();
        const needsRestart =
          (opts.deviceId ?? 'default') !== (cur.deviceId ?? 'default') ||
          cur.echoCancellation !== opts.echoCancellation ||
          cur.noiseSuppression !== opts.noiseSuppression ||
          cur.autoGainControl !== opts.autoGainControl;
        if (needsRestart) await track.restartTrack(opts).catch((e) => toast.error('Микрофон', mediaErrorMessage(e)));
      }
    },

    applyVolumes: () => {
      if (!room) return;
      for (const p of room.remoteParticipants.values()) applyRemoteVolume(p);
    },

    onConnectivityRestored: () => {
      const s = get();
      if (!s.target) return;
      // Комната уже разорвана, а ожидание шло без сети — пробуем сразу
      if (s.status === 'reconnecting' && !room && networkWaiter) {
        const w = networkWaiter;
        w();
        return;
      }
      if (s.status === 'connected' && room && room.state === 'disconnected') startReconnect(s.target);
    },
  };
});

export function voiceTargetMatches(t: VoiceTarget | null, channelId: string): boolean {
  return !!t && t.kind === 'channel' && t.channelId === channelId;
}
