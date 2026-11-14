// Голосовые сообщения: имя вложения ↔ длительность (по ним чат узнаёт голосовое и показывает плеер).
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/settings', () => ({ useSettings: { getState: () => ({ prefs: {} }) } }));
const { formatClock, voiceDuration, voiceFileName } = await import('@/lib/voiceMessage');

describe('голосовые сообщения', () => {
  it('имя файла содержит длительность и распознаётся обратно', () => {
    expect(voiceFileName(12.4)).toBe('Голосовое сообщение 0:12.webm');
    expect(voiceFileName(3725)).toBe('Голосовое сообщение 62:05.webm');
    expect(voiceDuration({ name: voiceFileName(75), mime: 'audio/webm' })).toBe(75);
  });

  it('обычные аудиофайлы и другие вложения голосовыми не считаются', () => {
    expect(voiceDuration({ name: 'песня.webm', mime: 'audio/webm' })).toBeNull();
    expect(voiceDuration({ name: 'Голосовое сообщение 0:12.webm', mime: 'video/webm' })).toBeNull();
    expect(formatClock(0)).toBe('0:00');
  });
});
