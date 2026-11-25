import type { SfuCall } from './sfu/call';
import { VoiceGate } from './voiceGate';
import { useSettings } from '@/stores/settings';

function micConstraints(deviceId: string): MediaTrackConstraints {
  const p = useSettings.getState().prefs;
  return {
    deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
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
  // 1440p 60 к/с: потолок битрейта с запасом для движущейся картинки; реальный битрейт подстраивается под канал
  if (q === '1440p60') return { width: 2560, height: 1440, fps: 60, bitrate: 12_000_000 };
  return q === '1080p60'
    ? { width: 1920, height: 1080, fps: 30, bitrate: 5_000_000 }
    : q === '720p'
      ? { width: 1280, height: 720, fps: 30, bitrate: 2_000_000 }
      : { width: 1920, height: 1080, fps: 15, bitrate: 2_500_000 };
}

async function captureMic(deviceId: string, current: () => boolean): Promise<MediaStreamTrack> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId) });
  } catch (error) {
    const name = (error as Error).name;
    if (!current() || deviceId === 'default' || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw error;
    stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints('default') });
  }
  return stream.getAudioTracks()[0];
}

type SourceChanges = Parameters<SfuCall['setSources']>[0];

export class LocalVoiceMedia {
  private closed = false;
  private micRequest = 0;
  private cameraRequest = 0;
  private screenRequest = 0;
  private raw: MediaStreamTrack | null = null;
  private inputDevice = 'default';
  private gate: VoiceGate | null = null;
  private camera: MediaStreamTrack | null = null;
  private screen: MediaStream | null = null;
  private publishing = Promise.resolve();

  constructor(
    private readonly context: AudioContext,
    private readonly call: Pick<SfuCall, 'setSources' | 'canSpeak'>,
    private readonly onLevel: (db: number, open: boolean) => void,
  ) {}

  get micTrack() { return this.gate?.processedTrack; }
  get cameraTrack() { return this.camera; }
  get screenTrack() { return this.screen?.getVideoTracks()[0] ?? null; }
  get hasScreenAudio() { return !!this.screen?.getAudioTracks().length; }

  setMuted(muted: boolean) {
    if (this.micTrack) this.micTrack.enabled = !muted;
  }

  setPtt(pressed: boolean) { this.gate?.setPtt(pressed); }

  private publish(changes: SourceChanges, current: () => boolean = () => true) {
    const work = this.publishing.then(() => {
      if (!this.closed && current()) return this.call.setSources(changes);
    });
    this.publishing = work.catch(() => undefined);
    return work;
  }

  async startMic() {
    const request = ++this.micRequest;
    const current = () => !this.closed && request === this.micRequest;
    const device = useSettings.getState().prefs.inputDeviceId;
    const raw = await captureMic(device, current);
    if (!current()) {
      raw.stop();
      return null;
    }
    const gate = new VoiceGate(gateConfig());
    gate.onLevel = (db, open) => { if (this.gate === gate) this.onLevel(db, open); };
    try {
      await gate.init({ track: raw, audioContext: this.context });
      if (!current()) return null;
      this.stopMic();
      this.raw = raw;
      this.inputDevice = device;
      this.gate = gate;
      return gate.processedTrack ?? null;
    } finally {
      if (this.gate !== gate) {
        raw.stop();
        void gate.destroy();
      }
    }
  }

  publishMic(track: MediaStreamTrack) {
    return this.publish({ mic: { track } }, () => this.micTrack === track);
  }

  async applyMicPrefs() {
    const gate = this.gate;
    if (!gate || !this.raw) return;
    gate.setConfig(gateConfig());
    const request = ++this.micRequest;
    const current = () => this.gate === gate && request === this.micRequest;
    const device = useSettings.getState().prefs.inputDeviceId;
    const want = micConstraints(device);
    const actual = this.raw.getSettings();
    if (device === this.inputDevice && (device === 'default' || actual.deviceId === device)
      && actual.echoCancellation === want.echoCancellation && actual.noiseSuppression === want.noiseSuppression
      && actual.autoGainControl === want.autoGainControl) return;
    const next = await captureMic(device, current);
    try {
      if (!current()) return;
      await gate.restart({ track: next, audioContext: this.context });
      if (this.gate !== gate) return;
      this.raw?.stop();
      this.raw = next;
      this.inputDevice = device;
    } finally {
      if (this.raw !== next) next.stop();
    }
  }

  private stopMic() {
    void this.gate?.destroy();
    this.gate = null;
    this.raw?.stop();
    this.raw = null;
  }

  async startCamera(onEnded: () => void) {
    const request = ++this.cameraRequest;
    const current = () => !this.closed && request === this.cameraRequest;
    if (!this.call.canSpeak) throw new Error('В этом канале у вас режим слушателя');
    const preset = cameraPreset();
    const device = useSettings.getState().prefs.videoDeviceId;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: device ? { exact: device } : undefined, width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: preset.fps } },
      });
      if (!current()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const track = stream.getVideoTracks()[0];
      this.camera?.stop();
      this.camera = track;
      track.addEventListener('ended', () => { if (this.camera === track) onEnded(); });
      await this.publish({ camera: { track, encoding: { maxBitrate: preset.bitrate, maxFramerate: preset.fps } } }, current);
    } catch (error) {
      if (!current()) return;
      await this.stopCamera();
      throw error;
    }
  }

  async stopCamera() {
    this.cameraRequest++;
    this.camera?.stop();
    this.camera = null;
    await this.publish({ camera: null }).catch(() => undefined);
  }

  async startScreen(sourceId: string, withAudio: boolean, onEnded: () => void) {
    const request = ++this.screenRequest;
    const current = () => !this.closed && request === this.screenRequest;
    if (!this.call.canSpeak) throw new Error('В этом канале у вас режим слушателя');
    try {
      await window.rv?.screen.select(sourceId, withAudio);
      if (!current()) return;
      const preset = screenPreset();
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: preset.fps, max: preset.fps } },
        audio: withAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      });
      if (!current()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const replacing = !!this.screen;
      this.releaseScreen();
      this.screen = stream;
      const video = stream.getVideoTracks()[0];
      const audio = stream.getAudioTracks()[0];
      video.contentHint = preset.fps >= 60 ? 'motion' : 'detail';
      video.addEventListener('ended', () => { if (this.screen === stream) onEnded(); });
      // replaceTrack keeps the previous sender encodings. Republish to apply a new FPS/bitrate preset.
      if (replacing) await this.publish({ screen: null, screenAudio: null }).catch(() => undefined);
      await this.publish({
        screen: { track: video, encoding: { maxBitrate: preset.bitrate, maxFramerate: preset.fps } },
        screenAudio: audio ? { track: audio } : null,
      }, current);
    } catch (error) {
      if (!current()) return;
      await this.stopScreen();
      throw error;
    }
  }

  private releaseScreen() {
    const stream = this.screen;
    this.screen = null;
    stream?.getTracks().forEach((track) => track.stop());
  }

  async stopScreen() {
    this.screenRequest++;
    this.releaseScreen();
    await this.publish({ screen: null, screenAudio: null }).catch(() => undefined);
  }

  close() {
    this.closed = true;
    this.stopMic();
    this.camera?.stop();
    this.camera = null;
    this.releaseScreen();
  }
}
