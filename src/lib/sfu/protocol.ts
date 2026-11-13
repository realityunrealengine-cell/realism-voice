// Состав голосовой комнаты Cloudflare Realtime SFU (чистая логика, покрыта тестами).
//
// Кто в комнате и какие треки он публикует, участники сообщают друг другу через Supabase Realtime
// Presence (существующие приватные каналы и их права — изменений в базе нет):
//   * голосовой канал → тема `typing:<channelId>`: доступ = can_view_channel, ровно как право входа в канал;
//   * личный звонок   → тема `dm:<dmId>`: доступ только у двух участников переписки.
// Запись присутствия пропадает сама, когда соединение участника обрывается, — «зависших» участников нет.
// Медиа через Supabase не идут: только напрямую приложение ⇄ Cloudflare Realtime SFU.

export type Source = 'mic' | 'camera' | 'screen' | 'screenAudio';
export const SOURCES: readonly Source[] = ['mic', 'camera', 'screen', 'screenAudio'];
export type MediaKind = 'audio' | 'video';

export function sourceKind(s: Source): MediaKind {
  return s === 'mic' || s === 'screenAudio' ? 'audio' : 'video';
}

export type Quality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
export const QUALITIES: readonly Quality[] = ['excellent', 'good', 'poor', 'lost', 'unknown'];

export interface PublishedTrack {
  name: string;
  source: Source;
}

/** Участник комнаты по данным presence */
export interface RoomMember {
  userId: string;
  /** Экземпляр приложения (одно устройство) */
  session: string;
  joinedAt: number;
  /** Сессия публикации SFU (нужна остальным для подписки) */
  pub: string | null;
  tracks: PublishedTrack[];
  muted: boolean;
  deafened: boolean;
  quality: Quality;
}

/** Что участник сообщает о себе в presence */
export interface RoomPresencePayload {
  user_id: string;
  joined_at: number;
  at: number;
  pub: string | null;
  tracks: PublishedTrack[];
  muted: boolean;
  deafened: boolean;
  quality: Quality;
}

export function roomTopic(target: { kind: 'channel'; channelId: string } | { kind: 'dm'; dmId: string }): string {
  return target.kind === 'channel' ? `typing:${target.channelId}` : `dm:${target.dmId}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_RE = /^[A-Za-z0-9_-]{8,128}$/;
const TRACK_RE = /^(ch|dm)_[0-9a-f-]{36}\.(mic|camera|screen|screenAudio)\.[A-Za-z0-9_-]{8,32}$/;

export function isTrackName(v: unknown): v is string {
  return typeof v === 'string' && TRACK_RE.test(v);
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Проверка одной записи presence (данные из сети не доверенные) */
export function parseMember(meta: Record<string, unknown> | null | undefined): RoomMember | null {
  if (!meta || typeof meta.user_id !== 'string' || !UUID_RE.test(meta.user_id)) return null;
  if (typeof meta.session !== 'string' || meta.session.length === 0 || meta.session.length > 64) return null;
  const pub = typeof meta.pub === 'string' && SESSION_RE.test(meta.pub) ? meta.pub : null;
  const tracks: PublishedTrack[] = [];
  if (pub && Array.isArray(meta.tracks)) {
    for (const t of meta.tracks as Record<string, unknown>[]) {
      if (!t || !isTrackName(t.name) || !SOURCES.includes(t.source as Source)) continue;
      if (tracks.some((x) => x.source === t.source || x.name === t.name)) continue;
      tracks.push({ name: t.name, source: t.source as Source });
    }
  }
  return {
    userId: meta.user_id,
    session: meta.session,
    joinedAt: num(meta.joined_at, num(meta.at, 0)),
    pub,
    tracks,
    muted: meta.muted === true,
    deafened: meta.deafened === true,
    quality: QUALITIES.includes(meta.quality as Quality) ? (meta.quality as Quality) : 'unknown',
  };
}

export interface RoomView {
  /** Остальные участники: одна запись на пользователя (самое новое устройство) */
  others: RoomMember[];
  /** Этот же пользователь вошёл в комнату с другого устройства позже нас */
  superseded: boolean;
}

/**
 * Свести presence комнаты к списку участников.
 * У пользователя может оказаться две записи (вход со второго устройства): остаётся более новая,
 * а старое устройство, увидев это, выходит из голоса (как раньше при DUPLICATE_IDENTITY в LiveKit).
 */
export function reduceRoom(
  state: Record<string, Record<string, unknown>[] | undefined>,
  self: { userId: string; session: string; joinedAt: number },
): RoomView {
  const byUser = new Map<string, RoomMember>();
  let superseded = false;
  for (const metas of Object.values(state)) {
    for (const meta of metas ?? []) {
      const m = parseMember(meta);
      if (!m) continue;
      if (m.userId === self.userId) {
        if (m.session !== self.session && (m.joinedAt > self.joinedAt || (m.joinedAt === self.joinedAt && m.session > self.session))) {
          superseded = true;
        }
        continue;
      }
      const prev = byUser.get(m.userId);
      if (!prev || m.joinedAt > prev.joinedAt || (m.joinedAt === prev.joinedAt && m.session > prev.session)) byUser.set(m.userId, m);
    }
  }
  const others = [...byUser.values()].sort((a, b) => a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId));
  return { others, superseded };
}

/** Удалённый трек, на который нужно подписаться */
export interface RemoteTrackRef {
  name: string;
  session: string;
  source: Source;
  userId: string;
}

export function desiredTracks(others: RoomMember[]): RemoteTrackRef[] {
  const out: RemoteTrackRef[] = [];
  for (const m of others) {
    if (!m.pub) continue;
    for (const t of m.tracks) out.push({ name: t.name, session: m.pub, source: t.source, userId: m.userId });
  }
  return out;
}

/** Чем отличается желаемый набор подписок от текущего */
export function diffSubscriptions(current: Iterable<string>, desired: RemoteTrackRef[]): { add: RemoteTrackRef[]; remove: string[] } {
  const want = new Map(desired.map((d) => [d.name, d]));
  const have = new Set(current);
  return {
    add: desired.filter((d) => !have.has(d.name)),
    remove: [...have].filter((n) => !want.has(n)),
  };
}

/** Cloudflare принимает до 64 треков в одном запросе tracks/new — большие пачки делятся */
export const MAX_TRACKS_PER_REQUEST = 64;
