// Голосовая связь, видео и демонстрация экрана через Cloudflare Realtime SFU (WebRTC).
// Права и сессии SFU выдаёт Edge Function voice-sfu после проверки доступа в базе; состав комнаты
// участники сообщают друг другу через Supabase Realtime Presence (src/lib/sfu/*).
//
// Состояния: idle → connecting → connected ⇄ reconnecting → lost (соединение потеряно) / error (не удалось подключиться).
// Каждое подключение имеет «поколение» (ConnectionGeneration): если пользователь вышел или переключил канал,
// пока шло подключение, устаревший сеанс закрывается, а не остаётся «призраком» в канале.
import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { VoiceGate } from '@/lib/voiceGate';
import { sounds } from '@/lib/sounds';
import { ConnectionGeneration, StaleConnectionError } from '@/lib/reconnectPolicy';
import type { LiveParticipant } from '@/lib/voiceRoster';
import { voiceApi } from '@/lib/sfu/api';
import { voiceRealtime } from '@/lib/sfu/realtime';
import { AudioOut } from '@/lib/sfu/audioOut';
import { RoomFullError, SfuCall, type CallDeps } from '@/lib/sfu/call';
import { ClosedError } from '@/lib/sfu/peer';
import type { Quality, RoomMember, Source } from '@/lib/sfu/protocol';
import { useSettings } from './settings';
import { usePresence } from './presence';
import { useMessages } from './messages';
import { toast } from './ui';

export type { Quality } from '@/lib/sfu/protocol';

export type VoiceTarget =
  | { kind: 'channel'; serverId: string; channelId: string; name: string }
  | { kind: 'dm'; dmId: string; peerId: string; name: string };

export interface ParticipantView {
  identity: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  micMuted: boolean;
  quality: Quality;
  camera: MediaStreamTrack | null;
  screen: MediaStreamTrack | null;
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
  quality: Quality;
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
  /** Сеть или система вернулись (resume/online): проверить соединение */
  onConnectivityRestored: () => void;
}

/** Зависимости сеанса (подменяются в тестах) */
export const voiceDeps: { make: (target: VoiceTarget, userId: string, session: string, ev: ConstructorParameters<typeof SfuCall>[3]) => SfuCall; deps: () => CallDeps } = {
  deps: () => ({
    api: voiceApi,
    rt: voiceRealtime(),
    log: (m) => import.meta.env.DEV && console.debug('[voice]', m),
    level: (userId) => out?.level(`${userId}:mic`) ?? null,
  }),
  make: (target, userId, session, ev) =>
    new SfuCall(target.kind === 'channel' ? { kind: 'channel', channelId: target.channelId } : { kind: 'dm', dmId: target.dmId }, userId, session, ev, voiceDeps.deps()),
};

/** Экземпляр приложения: отличает это устройство от других устройств того же пользователя */
const CLIENT = crypto.randomUUID();

let call: SfuCall | null = null;
let myId: string | null = null;
let gate: VoiceGate | null = null;
let micRaw: MediaStreamTrack | null = null;
let cameraTrack: MediaStreamTrack | null = null;
let screenStream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let out: AudioOut | null = null;
let lastLevelPush = 0;
let speaking = new Set<string>();
let knownOthers: Set<string> | null = null;
const remoteVideo = new Map<string, { camera: MediaStreamTrack | null; screen: MediaStreamTrack | null; screenAudio: boolean }>();
const generation = new ConnectionGeneration();

function micConstraints(deviceId?: string): MediaTrackConstraints {
  const p = useSettings.getState().prefs;
  const id = deviceId ?? p.inputDeviceId;
  return {
    deviceId: id && id !== 'default' ? { exact: id } : undefined,
    echoCancellation: p.echoCancellation,
    noiseSuppression: p.noiseSuppression,
    autoGainControl: p.autoGainControl,
    channelCount: 1,
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

/** Параметры камеры и демонстрации (те же разрешения и битрейты, что были в LiveKit) */
function cameraPreset() {
  const q = useSettings.getState().prefs.cameraQuality;
  return q === '1080p'
    ? { width: 1920, height: 1080, fps: 30, bitrate: 3_000_000 }
    : q === '480p'
      ? { width: 960, height: 540, fps: 25, bitrate: 800_000 }
      : { width: 1280, height: 720, fps: 30, bitrate: 1_700_000 };
}

function screenPreset() {
  const q = useSettings.getState().prefs.screenQuality;
  return q === '1080p60'
    ? { width: 1920, height: 1080, fps: 30, bitrate: 5_000_000 }
    : q === '720p'
      ? { width: 1280, height: 720, fps: 30, bitrate: 2_000_000 }
      : { width: 1920, height: 1080, fps: 15, bitrate: 2_500_000 };
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

/** Участники комнаты в формате списка голосового канала */
export function liveParticipants(list: ParticipantView[]): LiveParticipant[] {
  return list.map((p) => ({ identity: p.identity, micMuted: p.micMuted, camera: !!p.camera, screen: !!p.screen, joinedAt: p.joinedAt }));
}

async function getMicTrack(): Promise<MediaStreamTrack> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
    return s.getAudioTracks()[0];
  } catch (e) {
    // Выбранный микрофон отключён — берём устройство по умолчанию
    const name = (e as { name?: string })?.name;
    if ((name === 'OverconstrainedError' || name === 'NotFoundError') && useSettings.getState().prefs.inputDeviceId !== 'default') {
      const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints('default') });
      return s.getAudioTracks()[0];
    }
    throw e;
  }
}

export const useVoice = create<VoiceState>((set, get) => {
  const sync = () => {
    const c = call;
    if (!c || !myId) {
      set({ participants: [] });
      return;
    }
    const s = get();
    const screenVideo = screenStream?.getVideoTracks()[0] ?? null;
    const views: ParticipantView[] = [
      {
        identity: myId,
        name: myId,
        isLocal: true,
        speaking: s.transmitting && !s.muted,
        micMuted: s.muted || !s.canSpeak,
        quality: s.quality,
        camera: s.camera ? cameraTrack : null,
        screen: s.screen ? screenVideo : null,
        hasScreenAudio: !!screenStream?.getAudioTracks().length,
        joinedAt: s.connectedAt,
      },
    ];
    for (const m of c.others) {
      const v = remoteVideo.get(m.userId);
      views.push({
        identity: m.userId,
        name: m.userId,
        isLocal: false,
        speaking: speaking.has(m.userId),
        micMuted: m.muted || !m.tracks.some((t) => t.source === 'mic'),
        quality: m.quality,
        camera: v?.camera && m.tracks.some((t) => t.source === 'camera') ? v.camera : null,
        screen: v?.screen && m.tracks.some((t) => t.source === 'screen') ? v.screen : null,
        hasScreenAudio: !!v?.screenAudio,
        joinedAt: m.joinedAt,
      });
    }
    set({ participants: views });
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

  const volumeOf = (userId: string, source: Source) => {
    const prefs = useSettings.getState().prefs;
    if (get().deafened) return 0;
    if (source === 'mic') return ((prefs.userVolumes[userId] ?? 100) / 100) * (prefs.outputVolume / 100);
    return prefs.outputVolume / 100;
  };

  const updatePtt = () => {
    const prefs = useSettings.getState().prefs;
    const active = !!call && prefs.voiceMode === 'ptt';
    if (active) void useSettings.getState().setApp({ ptt: prefs.pttBinding });
    window.rv?.ptt.setActive(active);
  };

  /** Микрофон: захват → шлюз VAD/PTT → постоянный трек для отправки */
  const startMic = async (c: SfuCall): Promise<MediaStreamTrack | null> => {
    if (!audioCtx) return null;
    const raw = await getMicTrack();
    const g = new VoiceGate(gateConfig());
    g.onLevel = (db, open) => {
      if (gate !== g) return;
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
    await g.init({ track: raw, audioContext: audioCtx });
    if (call !== c) {
      // Сеанс уже закрыт (выход во время запроса доступа к микрофону) — ничего не оставляем открытым
      void g.destroy();
      raw.stop();
      return null;
    }
    stopMic();
    micRaw = raw;
    gate = g;
    if (g.processedTrack) g.processedTrack.enabled = !get().muted;
    return g.processedTrack ?? null;
  };

  const stopMic = () => {
    void gate?.destroy();
    gate = null;
    micRaw?.stop();
    micRaw = null;
  };

  const stopCamera = () => {
    cameraTrack?.stop();
    cameraTrack = null;
  };

  const stopScreenMedia = () => {
    screenStream?.getTracks().forEach((t) => t.stop());
    screenStream = null;
  };

  /** Полная очистка: сеанс, RTCPeerConnection, медиапотоки, воспроизведение */
  const teardown = async () => {
    const c = call;
    call = null;
    knownOthers = null;
    speaking = new Set();
    remoteVideo.clear();
    out?.clear();
    stopMic();
    stopCamera();
    stopScreenMedia();
    window.rv?.ptt.setActive(false);
    await c?.close().catch(() => undefined);
  };

  const events = (h: { c: SfuCall | null }): ConstructorParameters<typeof SfuCall>[3] => ({
    roster: (others: RoomMember[]) => {
      if (call !== h.c) return;
      const ids = new Set(others.map((o) => o.userId));
      if (knownOthers && get().status === 'connected') {
        if ([...ids].some((id) => !knownOthers!.has(id))) sounds.join();
        if ([...knownOthers].some((id) => !ids.has(id))) sounds.leave();
      }
      knownOthers = ids;
      for (const id of [...remoteVideo.keys()]) if (!ids.has(id)) remoteVideo.delete(id);
      sync();
    },
    track: (userId, source, track) => {
      if (call !== h.c) return;
      const key = `${userId}:${source}`;
      if (source === 'mic' || source === 'screenAudio') {
        if (track && out) out.add(key, userId, source, track);
        else out?.remove(key);
        if (source === 'screenAudio') {
          const v = remoteVideo.get(userId) ?? { camera: null, screen: null, screenAudio: false };
          remoteVideo.set(userId, { ...v, screenAudio: !!track });
        }
      } else {
        const v = remoteVideo.get(userId) ?? { camera: null, screen: null, screenAudio: false };
        remoteVideo.set(userId, { ...v, [source]: track });
      }
      sync();
    },
    status: (status, attempt) => {
      if (call !== h.c) return;
      const s = get().status;
      if (s !== 'connected' && s !== 'reconnecting') return;
      set({ status, reconnectAttempt: attempt });
      sync();
      pushPresence();
    },
    lost: () => {
      if (call === h.c) giveUp();
    },
    superseded: () => {
      if (call === h.c) void endExternally('Вы подключились к голосовой связи с другого устройства — здесь соединение закрыто');
    },
    speaking: (ids) => {
      if (call !== h.c) return;
      speaking = ids;
      sync();
    },
    quality: (q) => {
      if (call !== h.c) return;
      set({ quality: q });
      sync();
    },
  });

  /** Отключение не по воле пользователя, без автоматического повтора */
  const endExternally = async (notice: string) => {
    generation.invalidate();
    await teardown();
    set({ status: 'idle', target: null, participants: [], connectedAt: null, camera: false, screen: false, transmitting: false, notice, reconnectAttempt: 0 });
    pushPresence();
    toast.info(notice);
  };

  const giveUp = () => {
    generation.invalidate();
    void teardown();
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

  const connect = async (target: VoiceTarget, gen: number) => {
    const ensureCurrent = async () => {
      if (generation.isCurrent(gen)) return;
      throw new StaleConnectionError();
    };
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user.id;
    if (!userId) throw new Error('Требуется вход в аккаунт');
    await ensureCurrent();
    myId = userId;
    audioCtx ??= new AudioContext({ latencyHint: 'interactive' });
    if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => undefined);
    out ??= new AudioOut(audioCtx);
    out.setVolumes(volumeOf);
    void out.setSink(useSettings.getState().prefs.outputDeviceId).catch(() => undefined);

    const holder: { c: SfuCall | null } = { c: null };
    const c = voiceDeps.make(target, userId, CLIENT, events(holder));
    holder.c = c;
    call = c;
    // Сеанс сам захватывает микрофон после проверки прав (слушателю микрофон не нужен)
    await c.start(async (canSpeak) => {
      if (!canSpeak) return {};
      try {
        const track = await startMic(c);
        if (call !== c) return {};
        return track ? { mic: { track } } : {};
      } catch (e) {
        toast.error('Микрофон недоступен', mediaErrorMessage(e));
        set({ muted: true });
        return {};
      }
    });
    if (call !== c || !generation.isCurrent(gen)) {
      if (call === c) call = null;
      await c.close();
      throw new StaleConnectionError();
    }
    set({ canSpeak: c.canSpeak, quality: c.quality });
    c.setFlags({ muted: get().muted || !c.canSpeak, deafened: get().deafened });
    get().applyVolumes();
    sync();
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
    quality: 'unknown',
    pttPressed: false,
    connectedAt: null,
    reconnectAttempt: 0,

    join: async (target) => {
      const s = get();
      if (sameTarget(s.target, target) && (s.status === 'connected' || s.status === 'connecting' || s.status === 'reconnecting')) return;
      if (call || s.target) await get().leave();
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
        if (target.kind === 'dm' && call && call.others.length === 0) {
          void useMessages.getState().send({ kind: 'dm', id: target.dmId }, '', [], null, 'call').catch(() => undefined);
        }
      } catch (e) {
        if (e instanceof StaleConnectionError || e instanceof ClosedError || !generation.isCurrent(gen)) return;
        const msg = e instanceof RoomFullError ? 'Канал заполнен' : e instanceof Error ? e.message : String(e);
        generation.invalidate();
        await teardown();
        set({ status: 'error', error: msg, participants: [], connectedAt: null });
        pushPresence();
      }
    },

    leave: async () => {
      generation.invalidate();
      const wasConnected = !!call && (get().status === 'connected' || get().status === 'reconnecting');
      const pending = teardown();
      set({ status: 'idle', target: null, participants: [], camera: false, screen: false, transmitting: false, error: null, connectedAt: null, reconnectAttempt: 0 });
      pushPresence();
      if (wasConnected) sounds.leave();
      await pending;
    },

    retry: async () => {
      const t = get().target;
      if (!t) return;
      generation.invalidate();
      await teardown();
      set({ status: 'idle' });
      await get().join(t);
    },

    toggleMute: () => {
      const muted = !get().muted;
      // Включение микрофона снимает и «оглушение»
      set({ muted, deafened: muted ? get().deafened : false });
      if (!muted) get().applyVolumes();
      muted ? sounds.mute() : sounds.unmute();
      if (gate?.processedTrack) gate.processedTrack.enabled = !muted;
      else if (!muted && call && get().canSpeak) {
        const c = call;
        void startMic(c)
          .then((track) => (track && call === c ? c.setSources({ mic: { track } }) : undefined))
          .catch((e) => toast.error('Микрофон недоступен', mediaErrorMessage(e)));
      }
      call?.setFlags({ muted: muted || !get().canSpeak, deafened: get().deafened });
      sync();
      pushPresence();
    },

    toggleDeafen: () => {
      const deafened = !get().deafened;
      set({ deafened, muted: deafened ? true : get().muted });
      deafened ? sounds.mute() : sounds.unmute();
      if (deafened && gate?.processedTrack) gate.processedTrack.enabled = false;
      get().applyVolumes();
      call?.setFlags({ muted: get().muted || !get().canSpeak, deafened });
      sync();
      pushPresence();
    },

    toggleCamera: async () => {
      const c = call;
      if (!c) return;
      const on = !get().camera;
      try {
        if (on) {
          if (!c.canSpeak) throw new Error('В этом канале у вас режим слушателя');
          const preset = cameraPreset();
          const deviceId = useSettings.getState().prefs.videoDeviceId || undefined;
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: preset.fps } },
          });
          const track = stream.getVideoTracks()[0];
          if (call !== c) {
            track.stop();
            return;
          }
          stopCamera();
          cameraTrack = track;
          track.addEventListener('ended', () => {
            if (cameraTrack === track && get().camera) void get().toggleCamera();
          });
          await c.setSources({ camera: { track, encoding: { maxBitrate: preset.bitrate, maxFramerate: preset.fps } } });
          set({ camera: true });
        } else {
          set({ camera: false });
          await c.setSources({ camera: null }).catch(() => undefined);
          stopCamera();
        }
      } catch (e) {
        toast.error('Камера недоступна', mediaErrorMessage(e));
        await c.setSources({ camera: null }).catch(() => undefined);
        stopCamera();
        set({ camera: false });
      }
      sync();
      pushPresence();
    },

    startScreen: async (sourceId, withAudio) => {
      const c = call;
      if (!c) return;
      try {
        if (!c.canSpeak) throw new Error('В этом канале у вас режим слушателя');
        await window.rv?.screen.select(sourceId, withAudio);
        const preset = screenPreset();
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: preset.fps, max: preset.fps } },
          audio: withAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
        });
        if (call !== c) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (screenStream) {
          await c.setSources({ screen: null, screenAudio: null }).catch(() => undefined);
          stopScreenMedia();
        }
        screenStream = stream;
        const video = stream.getVideoTracks()[0];
        const audio = stream.getAudioTracks()[0];
        video.contentHint = 'detail';
        // Окно закрыто или демонстрацию остановила система
        video.addEventListener('ended', () => {
          if (screenStream === stream) void get().stopScreen();
        });
        await c.setSources({
          screen: { track: video, encoding: { maxBitrate: preset.bitrate, maxFramerate: preset.fps } },
          ...(audio ? { screenAudio: { track: audio } } : {}),
        });
        set({ screen: true });
      } catch (e) {
        toast.error('Не удалось начать демонстрацию', (e as Error)?.message);
        await c.setSources({ screen: null, screenAudio: null }).catch(() => undefined);
        stopScreenMedia();
        set({ screen: false });
      }
      sync();
      pushPresence();
    },

    stopScreen: async () => {
      const c = call;
      set({ screen: false });
      if (c) await c.setSources({ screen: null, screenAudio: null }).catch(() => undefined);
      stopScreenMedia();
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
      if (!call) return;
      get().applyVolumes();
      try {
        await out?.setSink(prefs.outputDeviceId || 'default');
      } catch {
        /* устройство вывода может не поддерживаться */
      }
      if (gate && micRaw && audioCtx) {
        const want = micConstraints();
        const cur = micRaw.getSettings();
        const wantId = (want.deviceId as { exact?: string } | undefined)?.exact ?? 'default';
        const needsRestart =
          (wantId !== 'default' && wantId !== cur.deviceId) ||
          cur.echoCancellation !== want.echoCancellation ||
          cur.noiseSuppression !== want.noiseSuppression ||
          cur.autoGainControl !== want.autoGainControl;
        if (needsRestart) {
          try {
            const raw = await getMicTrack();
            const old = micRaw;
            // Отправляемый трек не меняется — меняется только вход шлюза, без нового согласования с SFU
            await gate.restart({ track: raw, audioContext: audioCtx });
            micRaw = raw;
            old?.stop();
          } catch (e) {
            toast.error('Микрофон', mediaErrorMessage(e));
          }
        }
      }
    },

    applyVolumes: () => {
      out?.setVolumes(volumeOf);
    },

    onConnectivityRestored: () => {
      const s = get();
      if (!s.target || !call) return;
      if (s.status === 'connected' || s.status === 'reconnecting') call.onConnectivityRestored();
    },
  };
});

export function voiceTargetMatches(t: VoiceTarget | null, channelId: string): boolean {
  return !!t && t.kind === 'channel' && t.channelId === channelId;
}
