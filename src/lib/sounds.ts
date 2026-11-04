// Короткие системные звуки, синтезируемые через Web Audio (без внешних файлов).
import { useSettings } from '@/stores/settings';

let ctx: AudioContext | null = null;

function audio(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(freqs: number[], duration = 0.09, gap = 0.02, type: OscillatorType = 'sine', volume = 0.12) {
  if (!useSettings.getState().prefs.sounds) return;
  const ac = audio();
  let t = ac.currentTime;
  for (const f of freqs) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);
    t += duration + gap;
  }
}

export const sounds = {
  message: () => tone([880, 1320], 0.07, 0.015, 'sine', 0.08),
  mention: () => tone([660, 990, 1320], 0.08, 0.02, 'triangle', 0.1),
  join: () => tone([523, 784], 0.09),
  leave: () => tone([784, 523], 0.09),
  mute: () => tone([440], 0.06, 0, 'triangle'),
  unmute: () => tone([660], 0.06, 0, 'triangle'),
  ring: () => tone([740, 988, 740, 988], 0.15, 0.05, 'sine', 0.1),
};
