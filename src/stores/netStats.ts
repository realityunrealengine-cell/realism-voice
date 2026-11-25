// Статистика сетевого трафика: только измеренные значения.
//   * медиа звонков — приращения bytesSent/bytesReceived транспорта WebRTC из getStats() (DTLS/ICE,
//     включая заголовки RTP/SRTP), раздельно для прямого пути, TURN и Cloudflare SFU;
//   * P2P-сообщения — байты, реально отправленные и принятые через DataChannel (зашифрованные кадры);
//   * сообщения через сервер — размер тела запросов/событий Supabase с сообщениями (полезная нагрузка
//     JSON, без HTTP/WebSocket-заголовков — это указано в интерфейсе).
// «Не прошло через сервер» = медиа и сообщения, переданные напрямую (P2P без TURN): эти байты
// физически не проходили ни через Cloudflare, ни через Supabase. Это измерение, а не прогноз.
//
// Запись на диск пакетная: счётчики копятся в памяти и сохраняются раз в 20 секунд и при закрытии.
import { create } from 'zustand';

export type StatKind = 'p2pMedia' | 'relayMedia' | 'sfuMedia' | 'p2pMsg' | 'serverMsg';
export const STAT_KINDS: StatKind[] = ['p2pMedia', 'relayMedia', 'sfuMedia', 'p2pMsg', 'serverMsg'];

export interface Counter {
  sent: number;
  received: number;
}

export type Totals = Record<StatKind, Counter>;

const KEY = 'rv-netstats-v1';
const FLUSH_MS = 20_000;

const zero = (): Totals => ({
  p2pMedia: { sent: 0, received: 0 },
  relayMedia: { sent: 0, received: 0 },
  sfuMedia: { sent: 0, received: 0 },
  p2pMsg: { sent: 0, received: 0 },
  serverMsg: { sent: 0, received: 0 },
});

function load(): { totals: Totals; since: number } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as { totals?: Partial<Totals>; since?: number };
      const t = zero();
      for (const k of STAT_KINDS) {
        const c = v.totals?.[k];
        if (c && Number.isFinite(c.sent) && Number.isFinite(c.received)) t[k] = { sent: c.sent, received: c.received };
      }
      return { totals: t, since: typeof v.since === 'number' ? v.since : Date.now() };
    }
  } catch {
    /* хранилище недоступно */
  }
  return { totals: zero(), since: Date.now() };
}

export interface LinkInfo {
  /** Собеседник (id пользователя) */
  peer: string;
  /** Чем связаны: звонок или канал сообщений */
  purpose: 'call' | 'messages';
  state: 'connecting' | 'connected' | 'failed' | 'closed';
  path: 'p2p' | 'relay' | 'sfu' | 'unknown';
  /** Тип локального/удалённого ICE-кандидата (host, srflx, prflx, relay) */
  candidates?: string | null;
  rttMs?: number | null;
  encrypted?: string | null;
}

interface NetStatsState {
  totals: Totals;
  session: Totals;
  since: number;
  links: Record<string, LinkInfo>;
  add: (kind: StatKind, sent: number, received: number) => void;
  setLink: (id: string, info: LinkInfo | null) => void;
  reset: () => void;
  flush: () => void;
}

const initial = load();
let dirty = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export const useNetStats = create<NetStatsState>((set, get) => ({
  totals: initial.totals,
  session: zero(),
  since: initial.since,
  links: {},

  add: (kind, sent, received) => {
    if (!(sent > 0) && !(received > 0)) return;
    const s = Math.max(0, Math.round(sent || 0));
    const r = Math.max(0, Math.round(received || 0));
    const bump = (t: Totals): Totals => ({ ...t, [kind]: { sent: t[kind].sent + s, received: t[kind].received + r } });
    set({ totals: bump(get().totals), session: bump(get().session) });
    dirty = true;
    timer ??= setTimeout(() => {
      timer = null;
      get().flush();
    }, FLUSH_MS);
  },

  setLink: (id, info) => {
    const links = { ...get().links };
    if (info) links[id] = info;
    else delete links[id];
    set({ links });
  },

  reset: () => {
    set({ totals: zero(), session: zero(), since: Date.now() });
    dirty = true;
    get().flush();
  },

  flush: () => {
    if (!dirty) return;
    dirty = false;
    try {
      localStorage.setItem(KEY, JSON.stringify({ totals: get().totals, since: get().since }));
    } catch {
      /* хранилище недоступно */
    }
  },
}));

if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => useNetStats.getState().flush());

/** Размер полезной нагрузки JSON в байтах (UTF-8) */
export function jsonBytes(v: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(v)).length;
  } catch {
    return 0;
  }
}

export const sum = (c: Counter) => c.sent + c.received;
