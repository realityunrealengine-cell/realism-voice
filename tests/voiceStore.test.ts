// Голосовой стор с заглушками LiveKit и Supabase: гонки подключения, второе устройство, обрывы.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- окружение «браузера» ----------
const win = Object.assign(new EventTarget(), { rv: undefined as unknown });
Object.assign(globalThis, { window: win });
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
class FakeAudioContext {
  state = 'running';
  async resume() {}
}
Object.assign(globalThis, { AudioContext: FakeAudioContext });

// ---------- управляемые обещания ----------
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ctl = {
  tokenGates: [] as ReturnType<typeof deferred>[],
  connectGates: [] as ReturnType<typeof deferred>[],
  tokenFails: false,
  autoToken: true,
  autoConnect: true,
};

// ---------- заглушки модулей ----------
vi.mock('livekit-client', () => {
  const RoomEvent = new Proxy({}, { get: (_t, k) => String(k) });
  class Room {
    static instances: Room[] = [];
    handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    state = 'disconnected';
    disconnected = false;
    remoteParticipants = new Map();
    localParticipant = {
      identity: 'me',
      name: 'me',
      connectionQuality: 'unknown',
      isSpeaking: false,
      isMicrophoneEnabled: true,
      joinedAt: new Date(),
      getTrackPublication: () => undefined,
      setMicrophoneEnabled: async () => undefined,
    };
    constructor() {
      Room.instances.push(this);
    }
    on(ev: string, fn: (...a: unknown[]) => void) {
      const list = this.handlers.get(ev) ?? [];
      list.push(fn);
      this.handlers.set(ev, list);
      return this;
    }
    removeAllListeners() {
      this.handlers.clear();
    }
    emit(ev: string, ...args: unknown[]) {
      for (const fn of [...(this.handlers.get(ev) ?? [])]) fn(...args);
    }
    async connect() {
      if (!ctl.autoConnect) {
        const g = deferred();
        ctl.connectGates.push(g);
        await g.promise;
      }
      this.state = 'connected';
    }
    async disconnect() {
      this.disconnected = true;
      this.state = 'disconnected';
    }
    async startAudio() {}
    async switchActiveDevice() {}
  }
  return {
    Room,
    RoomEvent,
    ConnectionQuality: { Unknown: 'unknown', Excellent: 'excellent' },
    DisconnectReason: { CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5, UNKNOWN_REASON: 0 },
    Track: { Source: { Camera: 'camera', ScreenShare: 'screen', ScreenShareAudio: 'screen_audio', Microphone: 'mic' }, Kind: { Audio: 'audio' } },
    LocalAudioTrack: class {},
    RemoteParticipant: class {},
    Participant: class {},
    RemoteTrack: class {},
    ScreenSharePresets: { h1080fps15: { encoding: {}, resolution: {} }, h1080fps30: { encoding: {}, resolution: {} }, h720fps30: { encoding: {}, resolution: {} } },
    VideoPresets: { h1080: { resolution: {} }, h720: { resolution: {} }, h540: { resolution: {} } },
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    functions: {
      invoke: vi.fn(async () => {
        if (!ctl.autoToken) {
          const g = deferred();
          ctl.tokenGates.push(g);
          await g.promise;
        }
        if (ctl.tokenFails) return { data: null, error: new Error('network down') };
        return { data: { token: 't', url: 'wss://lk.example', can_speak: true }, error: null };
      }),
    },
  },
}));
vi.mock('@/lib/errors', () => ({ functionErrorMessage: async (e: Error) => e.message }));
vi.mock('@/lib/voiceGate', () => ({ VoiceGate: class {} }));
vi.mock('@/lib/sounds', () => ({ sounds: { join() {}, leave() {}, mute() {}, unmute() {} } }));
const trackVoice = vi.fn();
vi.mock('@/stores/presence', () => ({ usePresence: { getState: () => ({ trackVoice }) } }));
vi.mock('@/stores/messages', () => ({ useMessages: { getState: () => ({ send: async () => undefined }) } }));
vi.mock('@/stores/ui', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('@/stores/settings', () => ({
  useSettings: {
    getState: () => ({
      prefs: {
        inputDeviceId: 'default', echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceMode: 'vad', vadThreshold: -50,
        inputVolume: 100, pttReleaseDelay: 200, cameraQuality: '720p', screenQuality: '1080p15', outputDeviceId: 'default', userVolumes: {},
        outputVolume: 100, pttBinding: { code: 'KeyV', label: 'V' },
      },
      setApp: async () => undefined,
    }),
  },
}));

const { useVoice } = await import('@/stores/voice');
const { Room } = (await import('livekit-client')) as unknown as { Room: { instances: { disconnected: boolean; state: string; emit: (e: string, ...a: unknown[]) => void }[] } };

const target = (channelId: string) => ({ kind: 'channel' as const, serverId: 'srv', channelId, name: channelId });

async function flush() {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

describe('голосовой стор', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    ctl.autoToken = true;
    ctl.autoConnect = true;
    ctl.tokenFails = false;
    ctl.tokenGates = [];
    ctl.connectGates = [];
    (navigator as { onLine: boolean }).onLine = true;
    await useVoice.getState().leave();
    Room.instances.length = 0;
    trackVoice.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('«призрак»: выход во время получения токена не оставляет подключённую комнату', async () => {
    ctl.autoToken = false;
    const p = useVoice.getState().join(target('A'));
    await flush();
    await useVoice.getState().leave();
    ctl.tokenGates[0].resolve();
    await p;
    await flush();
    expect(Room.instances).toHaveLength(0);
    expect(useVoice.getState()).toMatchObject({ status: 'idle', target: null });
  });

  it('«призрак»: выход во время подключения к LiveKit разрывает эту комнату', async () => {
    ctl.autoConnect = false;
    const p = useVoice.getState().join(target('A'));
    await flush();
    expect(Room.instances).toHaveLength(1);
    await useVoice.getState().leave();
    ctl.connectGates[0].resolve();
    await p;
    await flush();
    expect(Room.instances[0].disconnected).toBe(true);
    expect(useVoice.getState().status).toBe('idle');
    expect(trackVoice).toHaveBeenLastCalledWith(null, null);
  });

  it('переключение канала во время подключения: остаётся только новая комната', async () => {
    ctl.autoConnect = false;
    const p1 = useVoice.getState().join(target('A'));
    await flush();
    const p2 = useVoice.getState().join(target('B'));
    await flush();
    ctl.connectGates.forEach((g) => g.resolve());
    await flush();
    ctl.connectGates.forEach((g) => g.resolve());
    await Promise.all([p1, p2]);
    await flush();
    const live = Room.instances.filter((r) => !r.disconnected);
    expect(live).toHaveLength(1);
    expect(useVoice.getState()).toMatchObject({ status: 'connected', target: { channelId: 'B' } });
    expect(trackVoice).toHaveBeenLastCalledWith('srv', expect.objectContaining({ channel_id: 'B' }));
  });

  it('вход с другого устройства: без бесконечного переподключения и с понятной причиной', async () => {
    await useVoice.getState().join(target('A'));
    expect(useVoice.getState().status).toBe('connected');
    Room.instances[0].emit('Disconnected', 2 /* DUPLICATE_IDENTITY */);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(Room.instances).toHaveLength(1);
    expect(useVoice.getState()).toMatchObject({ status: 'idle', target: null });
    expect(useVoice.getState().notice).toMatch(/другого устройства/);
    expect(trackVoice).toHaveBeenLastCalledWith(null, null);
  });

  it('кратковременный обрыв: автоматическое переподключение, таймер звонка сохраняется', async () => {
    await useVoice.getState().join(target('A'));
    const startedAt = useVoice.getState().connectedAt;
    Room.instances[0].emit('Disconnected', 0);
    expect(useVoice.getState().status).toBe('reconnecting');
    // присутствие не снимается во время переподключения
    expect(trackVoice).not.toHaveBeenLastCalledWith(null, null);
    await vi.advanceTimersByTimeAsync(1_100);
    await flush();
    expect(Room.instances).toHaveLength(2);
    expect(useVoice.getState().status).toBe('connected');
    expect(useVoice.getState().connectedAt).toBe(startedAt);
  });

  it('нет интернета: попытки ждут сеть и продолжаются, когда она появляется', async () => {
    await useVoice.getState().join(target('A'));
    (navigator as { onLine: boolean }).onLine = false;
    Room.instances[0].emit('Disconnected', 0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(Room.instances).toHaveLength(1);
    expect(useVoice.getState().status).toBe('reconnecting');
    (navigator as { onLine: boolean }).onLine = true;
    win.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1_100);
    await flush();
    expect(Room.instances).toHaveLength(2);
    expect(useVoice.getState().status).toBe('connected');
  });

  it('окончательная потеря соединения: «Соединение потеряно» и удаление из списка участников', async () => {
    await useVoice.getState().join(target('A'));
    ctl.tokenFails = true;
    Room.instances[0].emit('Disconnected', 0);
    await vi.advanceTimersByTimeAsync(61_000);
    await flush();
    expect(useVoice.getState().status).toBe('lost');
    expect(useVoice.getState().participants).toEqual([]);
    expect(trackVoice).toHaveBeenLastCalledWith(null, null);
    // «Переподключиться»
    ctl.tokenFails = false;
    await useVoice.getState().retry();
    expect(useVoice.getState().status).toBe('connected');
  });
});
