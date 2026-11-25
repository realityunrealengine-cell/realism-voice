// Подмена npm:@supabase/supabase-js@2 для тестов Edge Functions (voice-sfu, account-security) в Node.
type Row = Record<string, unknown>;

export const edge = {
  /** Таблицы для account-security (ключ service_role) */
  tables: new Map<string, Row[]>(),
  /** Факторы MFA: userId → список */
  factors: new Map<string, { id: string; factor_type: string; status: string }[]>(),
  /** JWT → id пользователя */
  users: new Map<string, string>(),
  /** `${userId}:${channelId}` → права voice_access */
  channels: new Map<string, { can_join: boolean; can_speak: boolean; user_limit: number | null }>(),
  /** `${userId}:${dmId}` → dm_call_access */
  dms: new Set<string>(),
};

/** Минимальный построитель запросов PostgREST: select/insert/update/delete с фильтрами eq/is/gte */
function query(table: string) {
  const rows = () => edge.tables.get(table) ?? edge.tables.set(table, []).get(table)!;
  const filters: ((r: Row) => boolean)[] = [];
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  let patch: Row = {};
  let head = false;
  let returning = false;
  const b = {
    select(_cols?: string, o?: { count?: string; head?: boolean }) {
      if (op === 'select') head = !!o?.head;
      else returning = true;
      return b;
    },
    insert(v: Row | Row[]) {
      op = 'insert';
      patch = { rows: Array.isArray(v) ? v : [v] };
      return b;
    },
    update(v: Row) {
      op = 'update';
      patch = v;
      return b;
    },
    delete() {
      op = 'delete';
      return b;
    },
    eq(c: string, v: unknown) {
      filters.push((r) => r[c] === v);
      return b;
    },
    is(c: string, v: unknown) {
      filters.push((r) => (r[c] ?? null) === v);
      return b;
    },
    gte(c: string, v: string) {
      filters.push((r) => String(r[c]) >= v);
      return b;
    },
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      const all = rows();
      const match = all.filter((r) => filters.every((f) => f(r)));
      let out: unknown;
      if (op === 'insert') {
        for (const r of patch.rows as Row[]) all.push({ at: new Date().toISOString(), used_at: null, ...r });
        out = { data: null, error: null };
      } else if (op === 'update') {
        for (const r of match) Object.assign(r, patch);
        out = { data: returning ? match : null, error: null };
      } else if (op === 'delete') {
        edge.tables.set(table, all.filter((r) => !match.includes(r)));
        out = { data: null, error: null };
      } else out = { data: head ? null : match, count: match.length, error: null };
      return Promise.resolve(out).then(res, rej);
    },
  };
  return b;
}

export function createClient(_url: string, _key: string, opts: { global?: { headers: { Authorization: string } } }) {
  const jwt = (opts.global?.headers.Authorization ?? '').replace(/^Bearer /, '');
  const uid = edge.users.get(jwt) ?? null;
  return {
    from: (t: string) => query(t),
    auth: {
      async getUser(token: string) {
        const id = edge.users.get(token);
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: new Error('invalid jwt') };
      },
      admin: {
        mfa: {
          async listFactors({ userId }: { userId: string }) {
            return { data: { factors: edge.factors.get(userId) ?? [] }, error: null };
          },
          async deleteFactor({ id, userId }: { id: string; userId: string }) {
            edge.factors.set(userId, (edge.factors.get(userId) ?? []).filter((f) => f.id !== id));
            return { data: { id }, error: null };
          },
        },
      },
    },
    async rpc(name: string, args: Record<string, string>) {
      if (!uid) return { data: null, error: { message: 'JWT invalid' } };
      if (name === 'voice_access') {
        const a = edge.channels.get(`${uid}:${args.p_channel}`);
        return { data: a ? [a] : [], error: null };
      }
      if (name === 'dm_call_access') return { data: edge.dms.has(`${uid}:${args.p_dm}`), error: null };
      return { data: null, error: { message: 'unknown rpc' } };
    },
  };
}
