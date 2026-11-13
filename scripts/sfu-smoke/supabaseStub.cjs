// Заглушка Supabase для реальной проверки SFU: пользователь берётся из «JWT» вида user:<uuid>,
// доступ к комнате разрешён. Настоящие права проверяются тестами SQL и тестами функции.
exports.createClient = (_url, _key, opts) => {
  const jwt = String(opts.global.headers.Authorization || '').replace(/^Bearer /, '');
  const id = jwt.startsWith('user:') ? jwt.slice(5) : null;
  return {
    auth: {
      async getUser() {
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: new Error('no user') };
      },
    },
    async rpc(name) {
      if (name === 'voice_access') return { data: [{ can_join: true, can_speak: true, user_limit: null }], error: null };
      if (name === 'dm_call_access') return { data: true, error: null };
      return { data: null, error: { message: 'unknown rpc' } };
    },
  };
};
