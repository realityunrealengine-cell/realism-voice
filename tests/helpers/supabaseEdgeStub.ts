// Подмена npm:@supabase/supabase-js@2 для теста Edge Function voice-sfu в Node.
export const edge = {
  /** JWT → id пользователя */
  users: new Map<string, string>(),
  /** `${userId}:${channelId}` → права voice_access */
  channels: new Map<string, { can_join: boolean; can_speak: boolean; user_limit: number | null }>(),
  /** `${userId}:${dmId}` → dm_call_access */
  dms: new Set<string>(),
};

export function createClient(_url: string, _key: string, opts: { global: { headers: { Authorization: string } } }) {
  const jwt = opts.global.headers.Authorization.replace(/^Bearer /, '');
  const uid = edge.users.get(jwt) ?? null;
  return {
    auth: {
      async getUser(token: string) {
        const id = edge.users.get(token);
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: new Error('invalid jwt') };
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
