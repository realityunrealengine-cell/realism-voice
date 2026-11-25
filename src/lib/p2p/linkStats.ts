// Тип установленного WebRTC-соединения и переданный объём по данным getStats() — реальные измерения
// браузера, а не оценка. «relay» — выбранная пара ICE-кандидатов идёт через TURN-сервер;
// «p2p» — напрямую между компьютерами (host / srflx / prflx), без промежуточного сервера.

export type PathKind = 'p2p' | 'relay' | 'unknown';

export interface LinkSnapshot {
  kind: PathKind;
  /** Тип локального и удалённого кандидата (host, srflx, prflx, relay) */
  local: string | null;
  remote: string | null;
  bytesSent: number;
  bytesReceived: number;
  rttMs: number | null;
}

type Stat = Record<string, unknown> & { id?: string; type?: string };

export function snapshotFromStats(stats: Stat[]): LinkSnapshot {
  const byId = new Map<string, Stat>();
  for (const s of stats) if (typeof s.id === 'string') byId.set(s.id, s);
  let pair: Stat | undefined;
  let bytesSent = 0;
  let bytesReceived = 0;
  let haveTransport = false;
  for (const s of stats) {
    if (s.type !== 'transport') continue;
    haveTransport = true;
    bytesSent += Number(s.bytesSent ?? 0);
    bytesReceived += Number(s.bytesReceived ?? 0);
    const sel = typeof s.selectedCandidatePairId === 'string' ? byId.get(s.selectedCandidatePairId) : undefined;
    if (sel) pair = sel;
  }
  if (!pair) {
    // Без transport-статистики: выбранная пара — номинированная и успешная
    pair = stats.find((s) => s.type === 'candidate-pair' && s.nominated === true && s.state === 'succeeded') ?? stats.find((s) => s.type === 'candidate-pair' && s.selected === true);
  }
  if (!haveTransport && pair) {
    bytesSent = Number(pair.bytesSent ?? 0);
    bytesReceived = Number(pair.bytesReceived ?? 0);
  }
  const lc = pair && typeof pair.localCandidateId === 'string' ? byId.get(pair.localCandidateId) : undefined;
  const rc = pair && typeof pair.remoteCandidateId === 'string' ? byId.get(pair.remoteCandidateId) : undefined;
  const local = typeof lc?.candidateType === 'string' ? lc.candidateType : null;
  const remote = typeof rc?.candidateType === 'string' ? rc.candidateType : null;
  const kind: PathKind = !pair || (!local && !remote) ? 'unknown' : local === 'relay' || remote === 'relay' ? 'relay' : 'p2p';
  const rtt = typeof pair?.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null;
  return { kind, local, remote, bytesSent, bytesReceived, rttMs: rtt };
}

export async function linkSnapshot(pc: RTCPeerConnection): Promise<LinkSnapshot> {
  const report = await pc.getStats();
  return snapshotFromStats([...report.values()] as Stat[]);
}
