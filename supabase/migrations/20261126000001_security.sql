-- =====================================================================
-- Realism Voice — 0010: двухфакторная аутентификация и активные сессии (версия 1.3.0)
--
--   * Резервные коды 2FA: только хэши (HMAC), клиентам таблицы недоступны — работает Edge Function
--     account-security ключом service_role.
--   * Список своих активных сессий и отзыв отдельной сессии (my_sessions / revoke_session).
--   * Обязательность 2FA на сервере: если у пользователя есть подтверждённый фактор TOTP, данные
--     доступны только сессии, прошедшей второй фактор (aal2). Пользователей без 2FA это НЕ касается —
--     для них всё работает как раньше (политики RESTRICTIVE возвращают true).
--
-- Миграция только добавляет объекты, ничего не удаляет и не меняет существующие данные.
-- Повторный запуск безопасен.
-- =====================================================================

-- ---------- резервные коды ----------
create table if not exists public.mfa_recovery_codes (
  user_id uuid not null references auth.users (id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, code_hash)
);
alter table public.mfa_recovery_codes enable row level security;
revoke all on public.mfa_recovery_codes from anon, authenticated;

create table if not exists public.mfa_recovery_attempts (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  at timestamptz not null default now(),
  ok boolean not null
);
create index if not exists mfa_recovery_attempts_user_at on public.mfa_recovery_attempts (user_id, at);
alter table public.mfa_recovery_attempts enable row level security;
revoke all on public.mfa_recovery_attempts from anon, authenticated;

-- ---------- уровень подтверждения сессии ----------
-- true: сессия прошла 2FA (aal2) или у пользователя 2FA не включена
create or replace function public.mfa_satisfied()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = (select auth.uid()) and f.status = 'verified'
      )
$$;
revoke all on function public.mfa_satisfied() from public;
grant execute on function public.mfa_satisfied() to anon, authenticated;

-- ---------- активные сессии ----------
create or replace function public.my_sessions()
returns table (id uuid, created_at timestamptz, updated_at timestamptz, user_agent text, ip text, aal text, is_current boolean)
language sql stable security definer set search_path = '' as $$
  select s.id, s.created_at, s.updated_at, s.user_agent, host(s.ip), s.aal::text,
         s.id = nullif((select auth.jwt() ->> 'session_id'), '')::uuid
  from auth.sessions s
  where s.user_id = (select auth.uid())
  order by coalesce(s.updated_at, s.created_at) desc
  limit 50
$$;
revoke all on function public.my_sessions() from public;
grant execute on function public.my_sessions() to authenticated;

-- Отзыв своей сессии: удаление записи сессии делает её токены обновления недействительными
-- (выданный токен доступа истекает сам в течение срока жизни JWT)
create or replace function public.revoke_session(p_session uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_count int;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if not public.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  delete from auth.sessions where id = p_session and user_id = auth.uid();
  get diagnostics v_count = row_count;
  return v_count > 0;
end $$;
revoke all on function public.revoke_session(uuid) from public;
grant execute on function public.revoke_session(uuid) to authenticated;

-- ---------- 2FA обязательна для данных (только у пользователей с включённой 2FA) ----------
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'profiles', 'servers', 'server_members', 'categories', 'channels', 'channel_allowed_members',
    'messages', 'message_reactions', 'dm_conversations', 'friendships', 'blocks', 'invites',
    'read_states', 'server_bans', 'attachment_uploads', 'attachment_downloads'
  ] loop
    if to_regclass('public.' || v_table) is null then continue; end if;
    execute format('drop policy if exists rv_mfa_required on public.%I', v_table);
    execute format(
      'create policy rv_mfa_required on public.%I as restrictive for all to authenticated
         using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()))',
      v_table);
  end loop;
end $$;

drop policy if exists rv_mfa_required on storage.objects;
create policy rv_mfa_required on storage.objects as restrictive for all to authenticated
  using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()));

drop policy if exists rv_mfa_required on realtime.messages;
create policy rv_mfa_required on realtime.messages as restrictive for all to authenticated
  using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()));

-- Функции базы (RPC) с security definer политиками RLS не проверяются — поэтому та же проверка
-- выполняется перед КАЖДЫМ запросом к API (PostgREST db_pre_request). Для пользователей без 2FA
-- и для анонимных запросов (регистрация) функция ничего не делает.
create or replace function public.rv_check_request()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and not public.mfa_satisfied() then
    raise sqlstate 'PT403' using message = 'mfa_required', hint = 'Подтвердите вход кодом двухфакторной аутентификации';
  end if;
end $$;
revoke all on function public.rv_check_request() from public;
grant execute on function public.rv_check_request() to anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'alter role authenticator set pgrst.db_pre_request = ''public.rv_check_request''';
  end if;
end $$;
notify pgrst, 'reload config';
