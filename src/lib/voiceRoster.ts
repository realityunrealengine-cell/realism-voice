// Состав голосовых каналов: один согласованный источник для счётчика и списка участников.
//
// Почему так. Раньше счётчик «N в канале» брался из комнаты LiveKit, а список в левой панели —
// из Supabase Presence. Если presence-канал клиента «умирал» (сервер закрывал его после истечения
// токена, сна Windows или быстрого переключения серверов), список переставал обновляться и расходился
// со счётчиком. Теперь:
//   * для канала, к которому подключён сам пользователь, состав определяет LiveKit (там реальные
//     медиасоединения), presence лишь дополняет флаги (заглушён, без звука, камера, экран);
//   * для остальных каналов состав берётся из presence — других данных у клиента нет;
//   * статус «В сети»/«Невидимый» на состав голосового канала не влияет.

export interface VoiceMember {
  user_id: string;
  channel_id: string;
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  screen: boolean;
  /** Время входа в канал (мс), чтобы у всех клиентов был одинаковый порядок */
  joined_at: number;
}

/** Метаданные presence, как их присылает Realtime (поля не доверенные) */
export interface VoicePresenceMeta {
  user_id?: unknown;
  channel_id?: unknown;
  muted?: unknown;
  deafened?: unknown;
  camera?: unknown;
  screen?: unknown;
  joined_at?: unknown;
  at?: unknown;
}

export interface LiveParticipant {
  identity: string;
  micMuted: boolean;
  camera: boolean;
  screen: boolean;
  joinedAt: number | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUserId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Свести состояние presence (ключ → список метаданных устройств) к одной записи на пользователя.
 * У пользователя может быть несколько устройств; в голосе одновременно бывает только одно
 * (LiveKit не пускает две сессии с одним identity), поэтому берётся самая свежая запись.
 */
export function reduceVoicePresence(state: Record<string, VoicePresenceMeta[] | undefined>): VoiceMember[] {
  const byUser = new Map<string, { m: VoiceMember; at: number }>();
  for (const metas of Object.values(state)) {
    for (const meta of metas ?? []) {
      if (!meta || !isUserId(meta.user_id) || !isUserId(meta.channel_id)) continue;
      const at = num(meta.at, num(meta.joined_at, 0));
      const prev = byUser.get(meta.user_id);
      if (prev && prev.at > at) continue;
      byUser.set(meta.user_id, {
        at,
        m: {
          user_id: meta.user_id,
          channel_id: meta.channel_id,
          muted: meta.muted === true,
          deafened: meta.deafened === true,
          camera: meta.camera === true,
          screen: meta.screen === true,
          joined_at: num(meta.joined_at, at),
        },
      });
    }
  }
  return sortRoster([...byUser.values()].map((v) => v.m));
}

export function sortRoster(list: VoiceMember[]): VoiceMember[] {
  return [...list].sort((a, b) => a.joined_at - b.joined_at || a.user_id.localeCompare(b.user_id));
}

/**
 * Участники конкретного голосового канала.
 * @param presence участники всех голосовых каналов сервера по presence
 * @param live если пользователь сам подключён к ЭТОМУ каналу — участники комнаты LiveKit
 */
export function channelRoster(channelId: string, presence: VoiceMember[], live: LiveParticipant[] | null): VoiceMember[] {
  if (!live) return sortRoster(presence.filter((m) => m.channel_id === channelId));
  const flags = new Map(presence.map((m) => [m.user_id, m]));
  const seen = new Set<string>();
  const out: VoiceMember[] = [];
  for (const p of live) {
    if (!p.identity || seen.has(p.identity)) continue;
    seen.add(p.identity);
    const f = flags.get(p.identity);
    const fromPresence = f && f.channel_id === channelId ? f : null;
    out.push({
      user_id: p.identity,
      channel_id: channelId,
      muted: p.micMuted || (fromPresence?.muted ?? false),
      deafened: fromPresence?.deafened ?? false,
      camera: p.camera,
      screen: p.screen,
      joined_at: p.joinedAt ?? fromPresence?.joined_at ?? Number.MAX_SAFE_INTEGER,
    });
  }
  return sortRoster(out);
}

/** Все участники голосовых каналов сервера с учётом комнаты LiveKit, к которой подключён пользователь */
export function serverRoster(presence: VoiceMember[], liveChannelId: string | null, live: LiveParticipant[] | null): VoiceMember[] {
  if (!liveChannelId || !live) return presence;
  const inLive = new Set(live.map((p) => p.identity));
  // Пользователь из комнаты LiveKit не может одновременно числиться в другом канале этого сервера
  const others = presence.filter((m) => m.channel_id !== liveChannelId && !inLive.has(m.user_id));
  return sortRoster([...others, ...channelRoster(liveChannelId, presence, live)]);
}
