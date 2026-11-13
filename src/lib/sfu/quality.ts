// Качество соединения по статистике WebRTC (чистая логика, покрыта тестами).
import type { Quality } from './protocol';

export interface LinkCounters {
  /** Пакеты, полученные от SFU, и потерянные по пути к нам */
  received: number;
  lost: number;
  /** Доля потерь наших пакетов по отчётам SFU (remote-inbound-rtp), 0..1 */
  remoteLoss: number | null;
  /** Время кругового пути, мс */
  rttMs: number | null;
}

export function emptyCounters(): LinkCounters {
  return { received: 0, lost: 0, remoteLoss: null, rttMs: null };
}

/** Собрать счётчики из отчёта getStats() одного соединения */
export function countersFromStats(report: Iterable<Record<string, unknown>>): LinkCounters {
  const c = emptyCounters();
  let rtt: number | null = null;
  const losses: number[] = [];
  for (const s of report) {
    if (s.type === 'inbound-rtp') {
      c.received += Number(s.packetsReceived) || 0;
      c.lost += Math.max(0, Number(s.packetsLost) || 0);
    } else if (s.type === 'remote-inbound-rtp') {
      if (typeof s.fractionLost === 'number') losses.push(s.fractionLost);
      if (typeof s.roundTripTime === 'number') rtt = Math.max(rtt ?? 0, s.roundTripTime * 1000);
    } else if (s.type === 'candidate-pair' && (s.nominated === true || s.selected === true) && s.state === 'succeeded') {
      if (typeof s.currentRoundTripTime === 'number') rtt = Math.max(rtt ?? 0, s.currentRoundTripTime * 1000);
    }
  }
  c.rttMs = rtt;
  c.remoteLoss = losses.length ? Math.max(...losses) : null;
  return c;
}

/** Оценка качества по приросту счётчиков между двумя замерами */
export function qualityFrom(prev: LinkCounters | null, cur: LinkCounters, connected: boolean): Quality {
  if (!connected) return 'lost';
  const dRecv = prev ? cur.received - prev.received : 0;
  const dLost = prev ? cur.lost - prev.lost : 0;
  const localLoss = dRecv + dLost > 20 ? Math.max(0, dLost) / (dRecv + Math.max(0, dLost)) : null;
  const loss = Math.max(localLoss ?? 0, cur.remoteLoss ?? 0);
  const rtt = cur.rttMs;
  if (localLoss === null && cur.remoteLoss === null && rtt === null) return 'unknown';
  if (loss > 0.1 || (rtt !== null && rtt > 500)) return 'poor';
  if (loss > 0.02 || (rtt !== null && rtt > 200)) return 'good';
  return 'excellent';
}

/** Худшее из нескольких соединений (публикация и приём) */
export function worst(list: Quality[]): Quality {
  const order: Quality[] = ['lost', 'poor', 'good', 'excellent', 'unknown'];
  for (const q of order) if (list.includes(q)) return q;
  return 'unknown';
}
