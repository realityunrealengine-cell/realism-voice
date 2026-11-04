// Голосовая связь, видео и демонстрация экрана через LiveKit (WebRTC SFU).
// Токен доступа выдаёт Edge Function livekit-token после проверки прав в базе.
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
}

type Status = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

interface VoiceState {
  status: Status;
  target: VoiceTarget | null;
  error: string | null;
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
  join: (target: VoiceTarget) => Promise<void>;
  leave: () => Promise<void>;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleCamera: () => Promise<void>;
  startScreen: (sourceId: string, withAudio: boolean) => Promise<void>;
  stopScreen: () => Promise<void>;
  setPtt: (pressed: boolean) => void;
  applyPrefs: () => Promise<void>;
  applyVolumes: () => void;
}

let room: Room | null = null;
let gate: VoiceGate | null = null;
let audioCtx: AudioContext | null = null;
let audioHost: HTMLDivElement | null = null;
let intentionalLeave = false;
let reconnectAttempts = 0;
let lastLevelPush = 0;

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

  const connect = async (target: VoiceTarget) => {
    const { token, url, can_speak } = await fetchToken(target);
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
    room = r;

    r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
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
      sync();
    });
    r.on(RoomEvent.ParticipantConnected, (p) => {
      sounds.join();
      applyRemoteVolume(p);
      sync();
    });
    r.on(RoomEvent.ParticipantDisconnected, () => {
      sounds.leave();
      sync();
    });
    for (const ev of [
      RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished,
      RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.ActiveSpeakersChanged, RoomEvent.ConnectionQualityChanged,
      RoomEvent.ParticipantNameChanged,
    ] as const) {
      r.on(ev, () => sync());
    }
    r.on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (pub.source === Track.Source.ScreenShare) {
        set({ screen: false });
        pushPresence();
      }
      if (pub.source === Track.Source.Camera) {
        set({ camera: false });
        pushPresence();
      }
    });
    r.on(RoomEvent.Reconnecting, () => set({ status: 'reconnecting' }));
    r.on(RoomEvent.Reconnected, () => {
      set({ status: 'connected' });
      pushPresence();
    });
    r.on(RoomEvent.MediaDevicesError, (e) => toast.error('Ошибка устройства', mediaErrorMessage(e)));
    r.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (room !== r) return;
      cleanupRoom();
      if (intentionalLeave) return;
      if (reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED) {
        set({ status: 'idle', target: null, connectedAt: null });
        toast.info('Вы отключены от голосового канала');
        pushPresence();
        return;
      }
      void reconnect(target);
    });

    await r.connect(url, token, { autoSubscribe: true });
    set({ canSpeak: !!can_speak });
    await r.startAudio().catch(() => undefined);
    try {
      await publishMic();
    } catch (e) {
      toast.error('Микрофон недоступен', mediaErrorMessage(e));
      set({ muted: true });
    }
    for (const p of r.remoteParticipants.values()) applyRemoteVolume(p);
    sync();
  };

  const cleanupRoom = () => {
    gate = null;
    if (audioHost) audioHost.innerHTML = '';
    room?.removeAllListeners();
    room = null;
    window.rv?.ptt.setActive(false);
  };

  const reconnect = async (target: VoiceTarget) => {
    if (reconnectAttempts >= 3) {
      set({ status: 'error', error: 'Соединение с голосовым сервером потеряно', participants: [], connectedAt: null });
      reconnectAttempts = 0;
      pushPresence();
      return;
    }
    reconnectAttempts++;
    set({ status: 'reconnecting', participants: [] });
    await new Promise((r) => setTimeout(r, 1000 * reconnectAttempts));
    if (get().target !== target) return;
    try {
      await connect(target);
      reconnectAttempts = 0;
      set({ status: 'connected', error: null });
      updatePtt();
      pushPresence();
    } catch {
      void reconnect(target);
    }
  };

  const updatePtt = () => {
    const prefs = useSettings.getState().prefs;
    const active = !!room && prefs.voiceMode === 'ptt';
    if (active) void useSettings.getState().setApp({ ptt: prefs.pttBinding });
    window.rv?.ptt.setActive(active);
  };

  return {
    status: 'idle',
    target: null,
    error: null,
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

    join: async (target) => {
      const cur = get().target;
      const same =
        cur &&
        ((cur.kind === 'channel' && target.kind === 'channel' && cur.channelId === target.channelId) ||
          (cur.kind === 'dm' && target.kind === 'dm' && cur.dmId === target.dmId));
      if (same && (get().status === 'connected' || get().status === 'connecting')) return;
      if (room) await get().leave();
      intentionalLeave = false;
      reconnectAttempts = 0;
      set({ status: 'connecting', target, error: null, camera: false, screen: false, transmitting: false, connectedAt: null });
      try {
        await connect(target);
        if (get().target !== target) return;
        set({ status: 'connected', connectedAt: Date.now() });
        sounds.join();
        updatePtt();
        pushPresence();
        // Звонок в ЛС: если собеседника ещё нет в комнате — отправляем уведомление о звонке
        if (target.kind === 'dm' && room && room.remoteParticipants.size === 0) {
          void useMessages.getState().send({ kind: 'dm', id: target.dmId }, '', [], null, 'call').catch(() => undefined);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        intentionalLeave = true;
        await room?.disconnect().catch(() => undefined);
        cleanupRoom();
        set({ status: 'error', error: msg, participants: [], connectedAt: null });
        pushPresence();
      }
    },

    leave: async () => {
      intentionalLeave = true;
      const r = room;
      cleanupRoom();
      set({ status: 'idle', target: null, participants: [], camera: false, screen: false, transmitting: false, error: null, connectedAt: null });
      pushPresence();
      if (r) {
        sounds.leave();
        await r.disconnect().catch(() => undefined);
      }
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
  };
});

export function voiceTargetMatches(t: VoiceTarget | null, channelId: string): boolean {
  return !!t && t.kind === 'channel' && t.channelId === channelId;
}
