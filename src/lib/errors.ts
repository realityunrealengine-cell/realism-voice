// Перевод ошибок Supabase/сети в понятные русские сообщения.

const AUTH_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Неверный email или пароль',
  email_not_confirmed: 'Email не подтверждён. Проверьте почту.',
  user_already_exists: 'Пользователь с таким email уже зарегистрирован',
  email_exists: 'Пользователь с таким email уже зарегистрирован',
  weak_password: 'Слишком простой пароль (минимум 8 символов)',
  over_email_send_rate_limit: 'Слишком много писем. Подождите немного и попробуйте снова.',
  over_request_rate_limit: 'Слишком много попыток. Подождите немного.',
  otp_expired: 'Код или ссылка устарели. Запросите новые.',
  same_password: 'Новый пароль должен отличаться от текущего',
  signup_disabled: 'Регистрация отключена в настройках Supabase',
  email_address_invalid: 'Некорректный email',
  session_not_found: 'Сессия истекла, войдите снова',
  flow_state_not_found: 'Ссылка открыта не в том приложении или устарела. Email подтверждён — войдите с паролем.',
  bad_code_verifier: 'Ссылка открыта не в том приложении. Войдите с паролем.',
};

export function errorMessage(err: unknown, fallback = 'Произошла ошибка'): string {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  const e = err as { code?: string; message?: string; status?: number; name?: string };
  if (e.code && AUTH_MESSAGES[e.code]) return AUTH_MESSAGES[e.code];
  const msg = e.message ?? '';
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'Нет соединения с сервером. Проверьте интернет.';
  if (e.code === 'PGRST205' || e.code === '42P01' || /schema cache|does not exist/i.test(msg))
    return 'База данных не настроена: примените SQL-миграции Realism Voice в Supabase.';
  if (e.code === 'PGRST202' || /Could not find the function/i.test(msg))
    return 'Серверная функция не найдена: примените SQL-миграции Realism Voice.';
  if (e.code === '42501' && /row-level security/i.test(msg)) return 'Недостаточно прав для этого действия';
  if (e.code === '23505') return 'Такое значение уже занято';
  if (e.code === '23514') return 'Некорректное значение';
  if (/Invalid login credentials/i.test(msg)) return AUTH_MESSAGES.invalid_credentials;
  if (/Email not confirmed/i.test(msg)) return AUTH_MESSAGES.email_not_confirmed;
  if (/User already registered/i.test(msg)) return AUTH_MESSAGES.user_already_exists;
  if (/Password should be/i.test(msg)) return AUTH_MESSAGES.weak_password;
  if (/rate limit/i.test(msg)) return AUTH_MESSAGES.over_request_rate_limit;
  if (/Payload too large|exceeded the maximum allowed size/i.test(msg)) return 'Файл слишком большой';
  if (/mime type/i.test(msg)) return 'Недопустимый тип файла';
  // Ошибки из наших SQL-функций уже на русском
  if (/[а-яё]/i.test(msg)) return msg;
  return msg || fallback;
}

/** Для supabase.functions.invoke: достаёт тело ответа с сообщением */
export async function functionErrorMessage(err: unknown): Promise<string> {
  const ctx = (err as { context?: Response })?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = await ctx.clone().json();
      if (body?.error === 'livekit_not_configured')
        return 'Голосовой сервер LiveKit не настроен. Администратору нужно задать секреты LIVEKIT_URL, LIVEKIT_API_KEY и LIVEKIT_API_SECRET в Supabase.';
      if (body?.message) return String(body.message);
    } catch {
      /* ignore */
    }
    if (ctx.status === 404) return 'Edge Function livekit-token не развёрнута в Supabase.';
  }
  const name = (err as { name?: string })?.name;
  if (name === 'FunctionsFetchError') return 'Не удалось связаться с Edge Function livekit-token (она развёрнута?).';
  return errorMessage(err);
}
