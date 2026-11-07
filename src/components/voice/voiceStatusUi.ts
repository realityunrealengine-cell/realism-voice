import type { VoiceStatus } from '@/stores/voice';

export type Tone = 'ok' | 'warn' | 'bad' | 'idle';

/** Единые подписи состояний голосовой связи для всех частей интерфейса */
export const VOICE_STATUS_UI: Record<VoiceStatus, { label: string; tone: Tone }> = {
  idle: { label: 'Не подключено', tone: 'idle' },
  connecting: { label: 'Подключение…', tone: 'warn' },
  connected: { label: 'Подключено', tone: 'ok' },
  reconnecting: { label: 'Переподключение…', tone: 'warn' },
  lost: { label: 'Соединение потеряно', tone: 'bad' },
  error: { label: 'Ошибка подключения', tone: 'bad' },
};

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  bad: 'text-rose-300',
  idle: 'text-slate-400',
};

export const TONE_PILL: Record<Tone, string> = {
  ok: 'bg-emerald-500/15 text-emerald-300',
  warn: 'bg-amber-500/15 text-amber-300',
  bad: 'bg-rose-500/15 text-rose-300',
  idle: 'bg-white/5 text-slate-400',
};

export const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-emerald-400',
  warn: 'animate-pulse bg-amber-400',
  bad: 'bg-rose-400',
  idle: 'bg-slate-500',
};
