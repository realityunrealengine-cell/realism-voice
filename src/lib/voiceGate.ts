// Обработка микрофона перед отправкой: громкость + шлюз Voice Activity Detection / Push-to-Talk.
// Звук не передаётся, пока шлюз закрыт (тишина ниже порога или клавиша PTT не нажата).
// На выходе — один постоянный трек (processedTrack): при смене микрофона меняется только вход,
// отправляемый в Cloudflare Realtime трек остаётся тем же.

export interface AudioProcessorOptions {
  track: MediaStreamTrack;
  audioContext: AudioContext;
}

export interface GateConfig {
  mode: 'vad' | 'ptt';
  thresholdDb: number;
  inputGain: number; // 0..2
  pttReleaseMs: number;
}

export class VoiceGate {
  name = 'rv-voice-gate';
  processedTrack?: MediaStreamTrack;

  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private gateNode: GainNode | null = null;
  private analyser: AudioNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buf: Float32Array<ArrayBuffer> = new Float32Array(512);
  private lastAbove = 0;
  private pttReleasedAt = 0;
  private open = false;

  config: GateConfig;
  pttPressed = false;
  onLevel: (db: number, open: boolean) => void = () => {};

  constructor(config: GateConfig) {
    this.config = config;
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    this.setup(opts);
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    this.teardown();
    this.setup(opts);
  }

  async destroy(): Promise<void> {
    this.teardown();
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    this.dest = null;
  }

  setConfig(patch: Partial<GateConfig>) {
    this.config = { ...this.config, ...patch };
    if (this.gainNode && this.ctx) this.gainNode.gain.setTargetAtTime(this.config.inputGain, this.ctx.currentTime, 0.02);
  }

  setPtt(pressed: boolean) {
    if (this.pttPressed && !pressed) this.pttReleasedAt = performance.now();
    this.pttPressed = pressed;
  }

  get isOpen() {
    return this.open;
  }

  private setup({ track, audioContext }: AudioProcessorOptions) {
    const ctx = audioContext;
    this.ctx = ctx;
    this.source = ctx.createMediaStreamSource(new MediaStream([track]));
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = this.config.inputGain;
    this.analyserNode = ctx.createAnalyser();
    this.analyserNode.fftSize = 512;
    this.analyser = this.analyserNode;
    this.gateNode = ctx.createGain();
    this.gateNode.gain.value = 0;
    // Выход сохраняется между перезапусками: отправляемый трек не меняется при смене микрофона
    this.dest ??= ctx.createMediaStreamDestination();
    this.source.connect(this.gainNode);
    this.gainNode.connect(this.analyserNode);
    this.gainNode.connect(this.gateNode);
    this.gateNode.connect(this.dest);
    this.processedTrack = this.dest.stream.getAudioTracks()[0];
    this.buf = new Float32Array(this.analyserNode.fftSize);
    this.timer = setInterval(() => this.tick(), 20);
  }

  private tick() {
    if (!this.analyserNode || !this.gateNode || !this.ctx) return;
    this.analyserNode.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    const now = performance.now();
    let shouldOpen: boolean;
    if (this.config.mode === 'ptt') {
      shouldOpen = this.pttPressed || now - this.pttReleasedAt < this.config.pttReleaseMs;
    } else {
      if (db > this.config.thresholdDb) this.lastAbove = now;
      shouldOpen = now - this.lastAbove < 350;
    }
    if (shouldOpen !== this.open) {
      this.open = shouldOpen;
      this.gateNode.gain.setTargetAtTime(shouldOpen ? 1 : 0, this.ctx.currentTime, shouldOpen ? 0.005 : 0.04);
    }
    this.onLevel(Math.max(-100, db), this.open);
  }

  private teardown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.source?.disconnect();
      this.gainNode?.disconnect();
      this.analyser?.disconnect();
      this.gateNode?.disconnect();
    } catch {
      /* ignore */
    }
    this.source = this.gainNode = this.gateNode = this.analyserNode = null;
    this.analyser = null;
    this.open = false;
  }
}

/** Измеритель уровня микрофона для проверки в настройках */
export async function createMicTester(
  deviceId: string,
  constraints: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean },
  onLevel: (db: number) => void,
  loopback: boolean,
): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined, ...constraints },
  });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  if (loopback) src.connect(ctx.destination);
  const buf = new Float32Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    onLevel(rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100);
  }, 40);
  return () => {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
}
