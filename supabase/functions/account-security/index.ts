// Realism Voice — Edge Function: резервные коды двухфакторной аутентификации.
//
// Сам второй фактор (TOTP) — встроенный Supabase Auth MFA. Supabase не умеет резервные коды, поэтому они
// реализованы здесь:
//   * recovery_generate — новые 10 кодов (только для сессии, уже подтверждённой 2FA, т.е. aal2).
//     В базе хранится лишь HMAC-SHA-256 кода (с секретом сервера) — по базе код не восстановить.
//   * recovery_status   — сколько неиспользованных кодов осталось.
//   * recovery_redeem   — вход по резервному коду, когда телефон с приложением-аутентификатором потерян:
//     код одноразовый; после успеха факторы TOTP пользователя удаляются (через Admin API), и пользователь
//     сразу настраивает 2FA заново. Перебор ограничен: 5 неудачных попыток за 15 минут.
//
// Таблицы mfa_recovery_codes / mfa_recovery_attempts закрыты для клиентов (RLS без политик) — к ним
// обращается только эта функция ключом service_role (переменная окружения Edge Functions по умолчанию).
// Необязательный секрет MFA_RECOVERY_PEPPER задаёт отдельный ключ HMAC.
//
// Файл самодостаточен — его можно вставить в редактор функций в Supabase Dashboard.

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CODES = 10;
const MAX_FAILS = 5;
const WINDOW_MIN = 15;
// Без похожих символов (0/O, 1/I/L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

let hmacKey: Promise<CryptoKey> | null = null;
function key(): Promise<CryptoKey> {
  const secret = Deno.env.get('MFA_RECOVERY_PEPPER') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!secret) throw new HttpError(503, 'not_configured', 'Сервер не настроен');
  hmacKey ??= crypto.subtle.importKey('raw', enc.encode('rv-mfa-recovery:' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hmacKey;
}

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function hashCode(userId: string, code: string): Promise<string> {
  return hex(await crypto.subtle.sign('HMAC', await key(), enc.encode(`${userId}:${normalizeCode(code)}`)));
}

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const s = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** Утверждения из JWT (подпись уже проверена auth.getUser) */
function claims(jwt: string): Record<string, unknown> {
  try {
    const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!url || !serviceKey) return json(503, { error: 'not_configured', message: 'Сервер не настроен' });

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json(401, { error: 'unauthorized', message: 'Требуется авторизация' });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object') throw new Error();
  } catch {
    return json(400, { error: 'bad_request', message: 'Некорректный запрос' });
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });

  try {
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    const userId = userData?.user?.id;
    if (userError || !userId) throw new HttpError(401, 'unauthorized', 'Сессия недействительна');
    const aal = claims(jwt).aal === 'aal2' ? 'aal2' : 'aal1';

    const factors = async () => {
      const { data, error } = await admin.auth.admin.mfa.listFactors({ userId });
      if (error) throw new HttpError(500, 'auth_error', 'Не удалось получить факторы 2FA');
      return (data?.factors ?? []) as { id: string; factor_type: string; status: string }[];
    };

    if (body.action === 'recovery_status') {
      const { count, error } = await admin.from('mfa_recovery_codes').select('code_hash', { count: 'exact', head: true }).eq('user_id', userId).is('used_at', null);
      if (error) throw new HttpError(500, 'db_error', 'Таблица резервных кодов недоступна (примените миграцию 20261126000001)');
      return json(200, { remaining: count ?? 0 });
    }

    if (body.action === 'recovery_generate') {
      if (aal !== 'aal2' || !(await factors()).some((f) => f.status === 'verified')) {
        throw new HttpError(403, 'aal2_required', 'Сначала подтвердите вход кодом двухфакторной аутентификации');
      }
      const codes = Array.from({ length: CODES }, newCode);
      const rows = await Promise.all(codes.map(async (c) => ({ user_id: userId, code_hash: await hashCode(userId, c) })));
      const del = await admin.from('mfa_recovery_codes').delete().eq('user_id', userId);
      if (del.error) throw new HttpError(500, 'db_error', 'Таблица резервных кодов недоступна (примените миграцию 20261126000001)');
      const ins = await admin.from('mfa_recovery_codes').insert(rows);
      if (ins.error) throw new HttpError(500, 'db_error', 'Не удалось сохранить коды');
      return json(200, { codes });
    }

    if (body.action === 'recovery_redeem') {
      const code = typeof body.code === 'string' ? body.code : '';
      if (normalizeCode(code).length !== 10) throw new HttpError(400, 'bad_code', 'Код состоит из 10 символов (например, ABCDE-FGH23)');
      const since = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString();
      const { count: fails } = await admin
        .from('mfa_recovery_attempts')
        .select('at', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('ok', false)
        .gte('at', since);
      if ((fails ?? 0) >= MAX_FAILS) throw new HttpError(429, 'too_many_attempts', `Слишком много неверных кодов. Повторите через ${WINDOW_MIN} минут.`);
      const h = await hashCode(userId, code);
      const { data: used, error } = await admin
        .from('mfa_recovery_codes')
        .update({ used_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('code_hash', h)
        .is('used_at', null)
        .select('code_hash');
      if (error) throw new HttpError(500, 'db_error', 'Таблица резервных кодов недоступна');
      const ok = (used?.length ?? 0) === 1;
      await admin.from('mfa_recovery_attempts').insert({ user_id: userId, ok });
      if (!ok) throw new HttpError(403, 'invalid_code', 'Неверный или уже использованный код');
      // Код верный: снимаем TOTP, чтобы пользователь вошёл и настроил 2FA заново
      for (const f of await factors()) {
        const r = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId });
        if (r.error) throw new HttpError(500, 'auth_error', 'Не удалось сбросить 2FA');
      }
      return json(200, { ok: true });
    }

    throw new HttpError(400, 'bad_request', 'Неизвестное действие');
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.code, message: e.message });
    console.error('account-security', e);
    return json(500, { error: 'internal', message: 'Внутренняя ошибка' });
  }
});
