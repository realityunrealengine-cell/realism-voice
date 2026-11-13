// Воспроизведение звука участников через Web Audio: громкость каждого участника до 200 %,
// общий уровень, «оглушение» и выбор устройства вывода (AudioContext.setSinkId).
// Каждый удалённый трек воспроизводится ровно один раз — без дублирования звука.
import type { Source } from './protocol';

interface Entry {
  userId: string;
  source: Source;
  el: HTMLAudioElement;
  node: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
}

export type VolumeFn = (userId: string, source: Source) => number;

export class AudioOut {
  private readonly entries = new Map<string, Entry>();
  private volume: VolumeFn = () => 1;

  constructor(private readonly ctx: AudioContext) {}

  add(key: string, userId: string, source: Source, track: MediaStreamTrack) {
    this.remove(key);
    const stream = new MediaStream([track]);
    // Chromium отдаёт в Web Audio звук удалённого WebRTC-трека, только если поток привязан к медиаэлементу.
    // Элемент без звука: слышно только то, что идёт через граф Web Audio.
    const el = document.createElement('audio');
    el.muted = true;
    el.autoplay = true;
    el.srcObject = stream;
    void el.play().catch(() => undefined);
    const node = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    gain.gain.value = this.volume(userId, source);
    node.connect(gain).connect(this.ctx.destination);
    // Уровень до регулятора громкости: индикатор «говорит» не зависит от громкости и «оглушения»
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    node.connect(analyser);
    this.entries.set(key, { userId, source, el, node, gain, analyser });
  }

  remove(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    try {
      e.node.disconnect();
      e.gain.disconnect();
      e.analyser.disconnect();
    } catch {
      /* ignore */
    }
    e.el.srcObject = null;
  }

  private buf = new Float32Array(512);

  /** Громкость принятого звука (RMS, 0..1) или null, если такого трека нет */
  level(key: string): number | null {
    const e = this.entries.get(key);
    if (!e) return null;
    e.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    return Math.sqrt(sum / this.buf.length);
  }

  setVolumes(fn: VolumeFn) {
    this.volume = fn;
    for (const e of this.entries.values()) e.gain.gain.setTargetAtTime(fn(e.userId, e.source), this.ctx.currentTime, 0.02);
  }

  async setSink(deviceId: string) {
    const ctx = this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };
    if (!ctx.setSinkId) return;
    const id = deviceId && deviceId !== 'default' ? deviceId : '';
    if ((ctx.sinkId ?? '') === id) return;
    await ctx.setSinkId(id);
  }

  clear() {
    for (const k of [...this.entries.keys()]) this.remove(k);
  }
}
