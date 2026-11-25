// Операции P2P-переписки и правила их приёма (чистая логика, покрыта тестами).
//
// Каждая операция имеет уникальный id (op): повторно принятая операция не применяется второй раз,
// но подтверждается — так отправитель перестаёт её повторять (защита от дублей при переотправке).
// Правила подлинности: устройство собеседника может сообщать только о СВОИХ сообщениях, правках и
// реакциях; другое устройство того же пользователя (синхронизация истории) — о сообщениях обоих.
// Сообщения хранятся с версией v: при синхронизации побеждает более новая версия (правка, удаление).
import type { OpKind, P2pStore, StoredMessage } from './store';

export const MAX_CONTENT = 4000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FUTURE_MS = 5 * 60_000;

export interface OpFrame {
  k: 'op';
  op: string;
  kind: OpKind;
  dm: string;
  data: Record<string, unknown>;
}

export interface ApplyContext {
  store: P2pStore;
  /** Я (владелец локальной истории) */
  me: string;
  dm: string;
  /** Собеседник в этой переписке */
  peer: string;
  /** Пользователь на другом конце канала (собеседник или я сам с другого устройства) */
  from: string;
  now?: number;
}

export type ApplyResult =
  | { status: 'applied'; message: StoredMessage; fresh: boolean }
  | { status: 'duplicate' }
  | { status: 'stale' }
  | { status: 'rejected'; reason: string };

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

export function parseFrame(obj: Record<string, unknown>): OpFrame | null {
  if (obj.k !== 'op' || typeof obj.op !== 'string' || obj.op.length > 128) return null;
  if (!['msg', 'edit', 'del', 'react'].includes(obj.kind as string)) return null;
  if (!isUuid(obj.dm) || !obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) return null;
  return { k: 'op', op: obj.op, kind: obj.kind as OpKind, dm: obj.dm, data: obj.data as Record<string, unknown> };
}

/** Кто может быть автором сообщения, пришедшего от `from` */
function authorAllowed(ctx: ApplyContext, author: string): boolean {
  if (author !== ctx.me && author !== ctx.peer) return false;
  if (ctx.from === ctx.peer) return author === ctx.peer;
  return ctx.from === ctx.me;
}

function sanitizeReactions(v: unknown, allowed: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [emoji, users] of Object.entries(v as Record<string, unknown>).slice(0, 50)) {
    if (emoji.length === 0 || emoji.length > 32 || !Array.isArray(users)) continue;
    const list = [...new Set(users.filter((u): u is string => typeof u === 'string' && allowed.includes(u)))];
    if (list.length) out[emoji] = list;
  }
  return out;
}

export async function applyOp(ctx: ApplyContext, f: OpFrame): Promise<ApplyResult> {
  if (f.dm !== ctx.dm) return { status: 'rejected', reason: 'wrong conversation' };
  if (await ctx.store.isSeen(f.op)) return { status: 'duplicate' };
  const now = ctx.now ?? Date.now();
  const d = f.data;
  const result = await applyInner(ctx, f, d, now);
  if (result.status === 'applied' || result.status === 'stale') ctx.store.markSeen(f.op);
  return result;
}

async function applyInner(ctx: ApplyContext, f: OpFrame, d: Record<string, unknown>, now: number): Promise<ApplyResult> {
  if (f.kind === 'msg') {
    if (!isUuid(d.id) || !isUuid(d.author_id) || typeof d.content !== 'string' || !isIso(d.created_at)) return { status: 'rejected', reason: 'bad message' };
    if (!authorAllowed(ctx, d.author_id)) return { status: 'rejected', reason: 'author' };
    if (d.content.length > MAX_CONTENT) return { status: 'rejected', reason: 'too long' };
    if (Date.parse(d.created_at) > now + MAX_FUTURE_MS) return { status: 'rejected', reason: 'future' };
    const v = typeof d.v === 'number' && Number.isFinite(d.v) ? d.v : Date.parse(d.created_at);
    const existing = await ctx.store.getMessage(d.id);
    if (existing && (existing.owner !== ctx.me || existing.dm_id !== ctx.dm || existing.author_id !== d.author_id)) return { status: 'rejected', reason: 'id conflict' };
    if (existing && existing.v >= v) return { status: 'stale' };
    const m: StoredMessage = {
      id: d.id,
      owner: ctx.me,
      dm_id: ctx.dm,
      author_id: d.author_id,
      content: d.content,
      reply_to_id: isUuid(d.reply_to_id) ? d.reply_to_id : null,
      kind: 'default',
      created_at: d.created_at,
      edited_at: isIso(d.edited_at) ? d.edited_at : null,
      deleted_at: isIso(d.deleted_at) ? d.deleted_at : null,
      reactions: sanitizeReactions(d.reactions, [ctx.me, ctx.peer]),
      v,
      delivered: existing?.delivered ?? (d.author_id === ctx.me ? d.delivered === true : undefined),
    };
    if (m.deleted_at) m.content = '';
    ctx.store.putMessage(m);
    return { status: 'applied', message: m, fresh: !existing };
  }

  if (!isUuid(d.id)) return { status: 'rejected', reason: 'bad id' };
  const existing = await ctx.store.getMessage(d.id);
  if (!existing || existing.owner !== ctx.me || existing.dm_id !== ctx.dm) return { status: 'rejected', reason: 'unknown message' };
  const at = typeof d.at === 'number' && Number.isFinite(d.at) ? Math.min(d.at, now + MAX_FUTURE_MS) : now;

  if (f.kind === 'edit' || f.kind === 'del') {
    // Править и удалять может только сам автор (правки с других устройств приходят синхронизацией версий)
    if (ctx.from !== existing.author_id) return { status: 'rejected', reason: 'not author' };
    if (existing.deleted_at) return { status: 'stale' };
    if (at <= existing.v && f.kind === 'edit') return { status: 'stale' };
    const m: StoredMessage = { ...existing, v: Math.max(existing.v + 1, at) };
    if (f.kind === 'edit') {
      if (typeof d.content !== 'string' || d.content.length > MAX_CONTENT || !d.content.trim()) return { status: 'rejected', reason: 'bad content' };
      m.content = d.content;
      m.edited_at = new Date(at).toISOString();
    } else {
      m.content = '';
      m.reactions = {};
      m.deleted_at = new Date(at).toISOString();
    }
    ctx.store.putMessage(m);
    return { status: 'applied', message: m, fresh: false };
  }

  // Реакция: ставит или снимает тот, кто прислал (с другого своего устройства — от своего имени)
  const user = d.user;
  if (typeof user !== 'string' || typeof d.emoji !== 'string' || d.emoji.length === 0 || d.emoji.length > 32 || typeof d.add !== 'boolean') {
    return { status: 'rejected', reason: 'bad reaction' };
  }
  if (!(ctx.from === ctx.peer ? user === ctx.peer : ctx.from === ctx.me && (user === ctx.me || user === ctx.peer))) return { status: 'rejected', reason: 'reaction user' };
  if (existing.deleted_at) return { status: 'stale' };
  const reactions = { ...existing.reactions };
  const users = new Set(reactions[d.emoji] ?? []);
  if (d.add) users.add(user);
  else users.delete(user);
  if (users.size) reactions[d.emoji] = [...users];
  else delete reactions[d.emoji];
  const m: StoredMessage = { ...existing, reactions, v: Math.max(existing.v + 1, at) };
  ctx.store.putMessage(m);
  return { status: 'applied', message: m, fresh: false };
}

/** Данные операции «сообщение» из сохранённой записи (для отправки и синхронизации истории) */
export function messageData(m: StoredMessage): Record<string, unknown> {
  return {
    id: m.id,
    author_id: m.author_id,
    content: m.content,
    reply_to_id: m.reply_to_id,
    created_at: m.created_at,
    edited_at: m.edited_at,
    deleted_at: m.deleted_at,
    reactions: m.reactions,
    v: m.v,
  };
}

/**
 * Что отправить собеседнику по его списку «что у меня есть» (синхронизация истории):
 * сообщения, которых у него нет или у которых у нас версия новее, и которые нам разрешено ему передавать.
 */
export function syncPlan(local: StoredMessage[], have: [string, number][], ctx: { me: string; peer: string; to: string }): StoredMessage[] {
  const theirs = new Map(have.filter((h) => Array.isArray(h) && typeof h[0] === 'string' && typeof h[1] === 'number'));
  return local.filter((m) => {
    // Устройству собеседника передаём только свои сообщения; своему устройству — все
    if (ctx.to === ctx.peer && m.author_id !== ctx.me) return false;
    const v = theirs.get(m.id);
    return v === undefined || v < m.v;
  });
}
