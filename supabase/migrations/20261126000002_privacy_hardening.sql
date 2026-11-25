-- =====================================================================
-- Realism Voice — 0011: закрытие утечек, найденных аудитом безопасности Supabase (версия 1.3.1)
--
-- Вспомогательные функции с security definer доступны через REST (/rest/v1/rpc/...) любому
-- вошедшему пользователю. Четыре из них отвечали на вопросы о ЧУЖИХ людях:
--   are_friends(a, b)            — дружат ли любые двое;
--   is_blocked_between(a, b)     — заблокировал ли кто-то кого-то;
--   member_role(server, user)    — состоит ли человек на (в т.ч. приватном) сервере и его роль;
--   extract_mentions(text, s, d) — по @username определяла участников чужих серверов и переписок.
-- Теперь пользователь получает ответ только о себе, о своих серверах и своих переписках. Внутри
-- базы (триггеры, функции действий) эти функции вызываются от имени участника — поведение не меняется.
-- Без пользователя (SQL Editor, service_role) ограничений нет.
--
-- Также: снят лишний доступ anon к функциям 2FA и зафиксирован search_path триггера значков.
-- Миграция только заменяет тела функций, данные не меняются. Повторный запуск безопасен.
-- =====================================================================

create or replace function public.is_blocked_between(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (auth.uid() is null or auth.uid() in (p_a, p_b)) and exists (
    select 1 from public.blocks b
    where (b.blocker_id = p_a and b.blocked_id = p_b) or (b.blocker_id = p_b and b.blocked_id = p_a)
  )
$$;

create or replace function public.are_friends(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (auth.uid() is null or auth.uid() in (p_a, p_b)) and exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and least(f.requester_id, f.addressee_id) = least(p_a, p_b)
      and greatest(f.requester_id, f.addressee_id) = greatest(p_a, p_b)
  )
$$;

create or replace function public.member_role(p_server uuid, p_user uuid default auth.uid())
returns public.server_role language sql stable security definer set search_path = '' as $$
  select sm.role from public.server_members sm
  where sm.server_id = p_server and sm.user_id = p_user
    and (
      auth.uid() is null
      or p_user = auth.uid()
      or exists (select 1 from public.server_members me where me.server_id = p_server and me.user_id = auth.uid())
    )
$$;

create or replace function public.extract_mentions(p_content text, p_server uuid, p_dm uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
  with names as (
    select distinct lower(m[1]) as username
    from regexp_matches(coalesce(p_content, ''), '@([A-Za-z0-9_.]{3,32})', 'g') as m
    limit 50
  ),
  allowed as (
    select
      auth.uid() is null
        or p_server is null
        or exists (select 1 from public.server_members me where me.server_id = p_server and me.user_id = auth.uid()) as srv,
      auth.uid() is null
        or p_dm is null
        or exists (select 1 from public.dm_conversations d where d.id = p_dm and auth.uid() in (d.user_low, d.user_high)) as dm
  )
  select coalesce(array_agg(p.id), '{}')
  from names n
  join public.profiles p on p.username = n.username
  cross join allowed a
  where a.srv and a.dm and (
        (p_server is not null and exists (select 1 from public.server_members sm
                                          where sm.server_id = p_server and sm.user_id = p.id))
     or (p_dm is not null and exists (select 1 from public.dm_conversations d
                                      where d.id = p_dm and p.id in (d.user_low, d.user_high))))
$$;

-- Функции 2FA и сессий анонимам не нужны (rv_check_request остаётся: PostgREST вызывает её и для anon)
revoke execute on function public.my_sessions() from anon;
revoke execute on function public.revoke_session(uuid) from anon;
revoke execute on function public.mfa_satisfied() from anon;

alter function public.profiles_protect_badge() set search_path = '';
