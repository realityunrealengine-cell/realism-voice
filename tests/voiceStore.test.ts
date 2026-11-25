// Голосовой стор поверх сеанса Cloudflare Realtime SFU (сеанс подменён): гонки подключения,
// второе устройство, обрыв и восстановление, личные звонки, микрофон, отсутствие утечек.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- окружение «браузера» ----------
const win = Object.assign(new EventTarget(), { rv: undefined as unknown });
Object.assign(globalThis, { window: win });
class FakeTrack extends EventTarget {
  readyState = 'live';
  enabled = true;
  constructor(readonly kind: string, readonly deviceId = 'default') { super(); }
  stop() {
    this.readyState = 'ended';
  }
  getSettings() {
    return { deviceId: this.deviceId, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  }

}
function stream(...tracks: FakeTrack[]) {
  return { getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'), getVideoTracks: () => tracks.filter((t) => t.kind === 'video'), getTracks: () => tracks };
}
const display = vi.fn();
const gum = vi.fn(async (_constraints?: MediaStreamConstraints) => stream(new FakeTrack('audio')));
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, mediaDevices: { getUserMedia: gum, getDisplayMedia: display } }, configurable: true, writable: true });
class FakeAudioContext {
  state = 'running';
  async resume() {}
}
Object.assign(globalThis, { AudioContext: FakeAudioContext });

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------- подменённый сеанс SFU ----------
const ctl = { autoStart: true, startError: null as unknown, canSpeak: true, others: [] as { userId: string }[] };
class FakeCall {
  static all: FakeCall[] = [];
  closed = false;
  canSpeak = true;
  quality = 'unknown';
  others: unknown[] = [];
  flags: { muted: boolean; deafened: boolean }[] = [];
  sources: unknown[] = [];
  gate = deferred();
  provided: unknown = null;
  constructor(
    readonly target: unknown,
    readonly ev: Record<string, (...a: unknown[]) => void>,
  ) {
    FakeCall.all.push(this);
  }
  async start(provide?: (canSpeak: boolean) => Promise<unknown>) {
    this.canSpeak = ctl.canSpeak;
    if (!ctl.autoStart) await this.gate.promise;
    if (this.closed) throw Object.assign(new Error('closed'), { name: 'ClosedError' });
    this.provided = provide ? await provide(this.canSpeak) : null;
    if (ctl.startError) throw ctl.startError;
    this.others = ctl.others.map((o) => ({ ...o, session: 's', joinedAt: 1, pub: null, tracks: [], muted: false, deafened: false, quality: 'good' }));
  }
  async close() {
    this.closed = true;
  }
  setFlags(f: { muted: boolean; deafened: boolean }) {
    this.flags.push(f);
  }
  async setSources(s: unknown) {
    this.sources.push(s);
  }
  onConnectivityRestored() {}
}

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }) } },
}));
vi.mock('@/lib/sfu/realtime', () => ({ voiceRealtime: () => ({}) }));
vi.mock('@/lib/sfu/api', () => ({ voiceApi: {} }));
const setSink = vi.fn(async (_id: string) => {});
vi.mock('@/lib/sfu/audioOut', () => ({
  AudioOut: class {
    setVolumes() {}
    setSink = setSink;
    add() {}
    remove() {}
    clear() {}
  },
}));
let inputDeviceId = 'default';
let screenQuality = '1080p';
const restartGate = vi.fn();
const configureGate = vi.fn();
const gates: { destroyed: boolean; processedTrack: FakeTrack }[] = [];
vi.mock('@/lib/voiceGate', () => ({
  VoiceGate: class {
    destroyed = false;
    processedTrack = new FakeTrack('audio');
    onLevel = () => {};
    constructor() {
      gates.push(this);
    }
    async init() {}
    restart = restartGate;
    async destroy() {
      this.destroyed = true;
    }
    setConfig = configureGate;
    setPtt() {}
  },
}));
vi.mock('@/lib/sounds', () => ({ sounds: { join() {}, leave() {}, mute() {}, unmute() {} } }));
const trackVoice = vi.fn();
vi.mock('@/stores/presence', () => ({ usePresence: { getState: () => ({ trackVoice }) } }));
const sendMessage = vi.fn(async () => undefined);
vi.mock('@/stores/messages', () => ({ useMessages: { getState: () => ({ send: sendMessage }) } }));
vi.mock('@/stores/ui', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('@/stores/settings', () => ({
  useSettings: {
    getState: () => ({
      prefs: {
        inputDeviceId, echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceMode: 'vad', vadThreshold: -50,
        inputVolume: 100, pttReleaseDelay: 200, cameraQuality: '720p', screenQuality, outputDeviceId: 'default', userVolumes: {},
        outputVolume: 100, pttBinding: { code: 'KeyV', label: 'V' },
      },
      setApp: async () => undefined,
    }),
  },
}));

const { useVoice, voiceDeps } = await import('@/stores/voice');
const { RoomFullError } = await import('@/lib/sfu/call');
voiceDeps.make = ((target: unknown, _u: string, _s: string, ev: Record<string, (...a: unknown[]) => void>) => new FakeCall(target, ev)) as never;

const target = (channelId: string) => ({ kind: 'channel' as const, serverId: 'srv', channelId, name: channelId });
const dm = { kind: 'dm' as const, dmId: 'd1', peerId: 'peer', name: 'Друг' };

async function flush() {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

describe('голосовой стор (Cloudflare Realtime SFU)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    Object.assign(ctl, { autoStart: true, startError: null, canSpeak: true, others: [] });
    await useVoice.getState().leave();
    if (useVoice.getState().muted) useVoice.getState().toggleMute();
    FakeCall.all.length = 0;
    gates.length = 0;
    trackVoice.mockClear();
    sendMessage.mockClear();
    gum.mockClear();
    display.mockReset();
    restartGate.mockReset();
    inputDeviceId = 'default';
    screenQuality = '1080p';
  });
  afterEach(() => vi.useRealTimers());

  it('«призрак»: выход во время подключения закрывает сеанс', async () => {
    ctl.autoStart = false;
    const p = useVoice.getState().join(target('A'));
    await flush();
    await useVoice.getState().leave();
    FakeCall.all[0].gate.resolve();
    await p;
    await flush();
    expect(FakeCall.all[0].closed).toBe(true);
    expect(useVoice.getState()).toMatchObject({ status: 'idle', target: null });
    expect(trackVoice).toHaveBeenLastCalledWith(null, null);
  });

  it('переключение канала во время подключения: остаётся только новый сеанс', async () => {
    ctl.autoStart = false;
    const p1 = useVoice.getState().join(target('A'));
    await flush();
    const p2 = useVoice.getState().join(target('B'));
    await flush();
    FakeCall.all.forEach((c) => c.gate.resolve());
    await Promise.all([p1, p2]);
    await flush();
    expect(FakeCall.all.filter((c) => !c.closed)).toHaveLength(1);
    expect(useVoice.getState()).toMatchObject({ status: 'connected', target: { channelId: 'B' } });
    expect(trackVoice).toHaveBeenLastCalledWith('srv', expect.objectContaining({ channel_id: 'B' }));
  });

  it('вход с другого устройства: понятная причина, без переподключения', async () => {
    await useVoice.getState().join(target('A'));
    FakeCall.all[0].ev.superseded();
    await flush();
    expect(FakeCall.all[0].closed).toBe(true);
    expect(useVoice.getState()).toMatchObject({ status: 'idle', target: null });
    expect(useVoice.getState().notice).toMatch(/другого устройства/);
    expect(trackVoice).toHaveBeenLastCalledWith(null, null);
  });

  it('восстановление: «Переподключение», присутствие и таймер разговора сохраняются', async () => {
    await useVoice.getState().join(target('A'));
    const startedAt = useVoice.getState().connectedAt;
    trackVoice.mockClear();
    FakeCall.all[0].ev.status('reconnecting', 2);
    expect(useVoice.getState()).toMatchObject({ status: 'reconnecting', reconnectAttempt: 2 });
    expect(trackVoice).not.toHaveBeenCalledWith(null, null);
    FakeCall.all[0].ev.status('connected', 0);
    expect(useVoice.getState()).toMatchObject({ status: 'connected', connectedAt: startedAt });
    expect(FakeCall.all).toHaveLength(1);
  });

  it('окончательная потеря: «Соединение потеряно», удаление из списка, затем «Переподключиться»', async () => {
    await useVoice.getState().join(target('A'));
    FakeCall.all[0].ev.lost();
    await flush();
    expect(useVoice.getState().status).toBe('lost');
    expect(useVoice.getState().participants).toEqual([]);
    expect(FakeCall.all[0].closed).toBe(true);
    expect(trackVoice).toHaveBeenLastCalledWith(null, null);
    await useVoice.getState().retry();
    expect(useVoice.getState().status).toBe('connected');
    expect(FakeCall.all).toHaveLength(2);
  });

  it('ошибка доступа: состояние «Ошибка подключения» с текстом сервера', async () => {
    ctl.startError = new Error('Нет доступа к этому голосовому каналу');
    await useVoice.getState().join(target('A'));
    expect(useVoice.getState()).toMatchObject({ status: 'error', error: 'Нет доступа к этому голосовому каналу' });
    expect(FakeCall.all[0].closed).toBe(true);
    // микрофон, захваченный до ошибки, освобождён
    expect(gates.every((g) => g.destroyed)).toBe(true);
  });

  it('канал заполнен', async () => {
    ctl.startError = new RoomFullError();
    await useVoice.getState().join(target('A'));
    expect(useVoice.getState()).toMatchObject({ status: 'error', error: 'Канал заполнен' });
  });

  it('исходящий звонок: уведомление отправляется, только если собеседника ещё нет', async () => {
    await useVoice.getState().join(dm);
    expect(sendMessage).toHaveBeenCalledWith({ kind: 'dm', id: 'd1' }, '', [], null, 'call');
    await useVoice.getState().leave();
    sendMessage.mockClear();
    ctl.others = [{ userId: 'peer' }];
    await useVoice.getState().join(dm);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(useVoice.getState().participants.map((p) => p.identity)).toEqual(['me', 'peer']);
  });

  it('микрофон: mute выключает отправляемый трек и сообщает флаг остальным', async () => {
    await useVoice.getState().join(target('A'));
    const g = gates[0];
    expect(FakeCall.all[0].provided).toEqual({ mic: { track: g.processedTrack } });
    useVoice.getState().toggleMute();
    expect(g.processedTrack.enabled).toBe(false);
    expect(FakeCall.all[0].flags.at(-1)).toEqual({ muted: true, deafened: false });
    useVoice.getState().toggleDeafen();
    expect(FakeCall.all[0].flags.at(-1)).toEqual({ muted: true, deafened: true });
    useVoice.getState().toggleMute();
    expect(g.processedTrack.enabled).toBe(true);
    expect(FakeCall.all[0].flags.at(-1)).toEqual({ muted: false, deafened: false });
  });

  it('освобождает микрофон, если разрешение на захват пришло после выхода', async () => {
    const raw = new FakeTrack('audio');
    const pending = deferred<ReturnType<typeof stream>>();
    gum.mockReturnValueOnce(pending.promise);
    const joining = useVoice.getState().join(target('A'));
    await flush();
    expect(gum).toHaveBeenCalledTimes(1);
    await useVoice.getState().leave();
    pending.resolve(stream(raw));
    await joining;
    expect(raw.readyState).toBe('ended');
    expect(FakeCall.all[0].provided).toEqual({});
    expect(useVoice.getState()).toMatchObject({ status: 'idle', participants: [] });
  });

  it('меняет микрофон и возвращается на системный без повторной публикации', async () => {
    const first = new FakeTrack('audio');
    const second = new FakeTrack('audio', 'usb');
    const third = new FakeTrack('audio');
    gum.mockResolvedValueOnce(stream(first)).mockResolvedValueOnce(stream(second)).mockResolvedValueOnce(stream(third));
    await useVoice.getState().join(target('A'));
    const published = gates[0].processedTrack;
    inputDeviceId = 'usb';
    await useVoice.getState().applyPrefs();
    expect(gum).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: { exact: 'usb' } }) });
    expect(first.readyState).toBe('ended');
    inputDeviceId = 'default';
    await useVoice.getState().applyPrefs();
    expect(restartGate.mock.calls.map(([opts]) => opts.track)).toEqual([second, third]);
    expect(second.readyState).toBe('ended');
    expect(third.readyState).toBe('live');
    expect(FakeCall.all[0].provided).toEqual({ mic: { track: published } });
    expect(FakeCall.all[0].sources).toEqual([]);
    await useVoice.getState().leave();
    expect(third.readyState).toBe('ended');
  });

  it('применяет настройки шлюза, пока система переключает аудиовыход', async () => {
    await useVoice.getState().join(target('A'));
    const switching = deferred();
    setSink.mockReturnValueOnce(switching.promise);
    configureGate.mockClear();
    const applying = useVoice.getState().applyPrefs();
    expect(configureGate).toHaveBeenCalledTimes(1);
    switching.resolve();
    await applying;
  });

  it('выход во время смены микрофона освобождает запоздавший трек', async () => {
    await useVoice.getState().join(target('A'));
    const raw = new FakeTrack('audio', 'usb');
    const pending = deferred<ReturnType<typeof stream>>();
    inputDeviceId = 'usb';
    gum.mockReturnValueOnce(pending.promise);
    const changing = useVoice.getState().applyPrefs();
    await flush();
    await useVoice.getState().leave();
    pending.resolve(stream(raw));
    await changing;
    expect(raw.readyState).toBe('ended');
    expect(restartGate).not.toHaveBeenCalled();
  });

  it('снимает локальную камеру с публикации, когда устройство завершает трек', async () => {
    await useVoice.getState().join(target('A'));
    const camera = new FakeTrack('video');
    gum.mockResolvedValueOnce(stream(camera));
    await useVoice.getState().toggleCamera();
    expect(useVoice.getState().participants[0].camera).toBe(camera);
    camera.dispatchEvent(new Event('ended'));
    await flush();
    expect(FakeCall.all[0].sources.at(-1)).toEqual({ camera: null });
    expect(camera.readyState).toBe('ended');
    expect(useVoice.getState().camera).toBe(false);
  });

  it.each(['button', 'ended'])('останавливает видео и звук демонстрации (%s)', async (how) => {
    await useVoice.getState().join(target('A'));
    const video = new FakeTrack('video'), audio = new FakeTrack('audio');
    display.mockResolvedValueOnce(stream(video, audio));
    await useVoice.getState().startScreen('display', true);
    expect(useVoice.getState().participants[0]).toMatchObject({ screen: video, hasScreenAudio: true });
    if (how === 'button') await useVoice.getState().stopScreen();
    else { video.dispatchEvent(new Event('ended')); await flush(); }
    expect(FakeCall.all[0].sources.at(-1)).toEqual({ screen: null, screenAudio: null });
    expect([video.readyState, audio.readyState]).toEqual(['ended', 'ended']);
    expect(useVoice.getState()).toMatchObject({ screen: false, participants: [{ screen: null, hasScreenAudio: false }] });
  });

  it('при замене экрана снимает прежнюю публикацию и применяет новые параметры кодирования', async () => {
    await useVoice.getState().join(target('A'));
    const first = new FakeTrack('video');
    const second = new FakeTrack('video');
    display.mockResolvedValueOnce(stream(first)).mockResolvedValueOnce(stream(second));
    await useVoice.getState().startScreen('first', false);
    screenQuality = '1440p60';
    await useVoice.getState().startScreen('second', false);
    expect(FakeCall.all[0].sources.slice(1)).toEqual([
      { screen: null, screenAudio: null },
      { screen: { track: second, encoding: { maxBitrate: 12_000_000, maxFramerate: 60 } }, screenAudio: null },
    ]);
    first.dispatchEvent(new Event('ended'));
    expect(first.readyState).toBe('ended');
    expect(second.readyState).toBe('live');
    expect(useVoice.getState().participants[0].screen).toBe(second);
  });

  it('остановка во время выбора экрана отменяет запоздалый захват', async () => {
    await useVoice.getState().join(target('A'));
    const video = new FakeTrack('video'), audio = new FakeTrack('audio');
    const pending = deferred<ReturnType<typeof stream>>();
    display.mockReturnValueOnce(pending.promise);
    const starting = useVoice.getState().startScreen('display', true);
    await flush();
    await useVoice.getState().stopScreen();
    pending.resolve(stream(video, audio));
    await starting;
    expect([video.readyState, audio.readyState]).toEqual(['ended', 'ended']);
    expect(useVoice.getState().screen).toBe(false);
    expect(FakeCall.all[0].sources).toEqual([{ screen: null, screenAudio: null }]);
  });

  it('режим слушателя: микрофон не запрашивается', async () => {
    ctl.canSpeak = false;
    await useVoice.getState().join(target('A'));
    expect(gum).not.toHaveBeenCalled();
    expect(useVoice.getState().canSpeak).toBe(false);
    expect(useVoice.getState().participants[0]).toMatchObject({ isLocal: true, micMuted: true });
  });

  it('выход: сеанс закрыт, микрофон освобождён, присутствие снято', async () => {
    await useVoice.getState().join(target('A'));
    await useVoice.getState().leave();
    expect(FakeCall.all[0].closed).toBe(true);
    expect(gates[0].destroyed).toBe(true);
    expect(trackVoice).toHaveBeenLastCalledWith(null, null);
    expect(useVoice.getState()).toMatchObject({ status: 'idle', participants: [] });
  });
});
