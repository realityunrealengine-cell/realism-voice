// Голосовые сообщения: запись микрофона в Opus (WebM) и оформление как обычного вложения.
// Отдельной таблицы не нужно: это вложение audio/webm, длительность записана в имени файла
// («Голосовое сообщение 0:12.webm») — старые версии приложения покажут его как файл.
import { useSettings } from '@/stores/settings';

export const VOICE_PREFIX = 'Голосовое сообщение';
const NAME_RE = /^Голосовое сообщение (\d+):(\d{2})\.webm$/;

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function voiceFileName(seconds: number): string {
  return `${VOICE_PREFIX} ${formatClock(seconds)}.webm`;
}

/** Длительность голосового сообщения по имени вложения или null, если это не голосовое */
export function voiceDuration(a: { name: string; mime: string }): number | null {
  if (!a.mime.startsWith('audio/')) return null;
  const m = NAME_RE.exec(a.name);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function pickMime(): string {
  const MR = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  for (const t of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm']) if (MR?.isTypeSupported?.(t)) return t;
  return 'audio/webm';
}

export interface Recording {
  /** Остановить и получить файл (null — запись пустая) */
  finish(): Promise<File | null>;
  /** Отменить без отправки */
  cancel(): void;
  startedAt: number;
}

/** Начать запись с выбранного в настройках микрофона (эхо- и шумоподавление — как в голосовой связи) */
export async function startRecording(): Promise<Recording> {
  const p = useSettings.getState().prefs;
  const id = p.inputDeviceId && p.inputDeviceId !== 'default' ? p.inputDeviceId : undefined;
  const constraints = { echoCancellation: p.echoCancellation, noiseSuppression: p.noiseSuppression, autoGainControl: p.autoGainControl, channelCount: 1 };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { ...constraints, deviceId: id ? { exact: id } : undefined } });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (!id || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw e;
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  }
  const mimeType = pickMime();
  const rec = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 48_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const startedAt = Date.now();
  rec.start(1000);
  const release = () => stream.getTracks().forEach((t) => t.stop());
  return {
    startedAt,
    cancel: () => {
      rec.onstop = null;
      if (rec.state !== 'inactive') rec.stop();
      release();
    },
    finish: () =>
      new Promise<File | null>((resolve) => {
        const seconds = (Date.now() - startedAt) / 1000;
        rec.onstop = () => {
          release();
          const blob = new Blob(chunks, { type: 'audio/webm' });
          resolve(blob.size > 0 && seconds >= 0.5 ? new File([blob], voiceFileName(seconds), { type: 'audio/webm' }) : null);
        };
        if (rec.state !== 'inactive') rec.stop();
        else rec.onstop?.(new Event('stop'));
      }),
  };
}
