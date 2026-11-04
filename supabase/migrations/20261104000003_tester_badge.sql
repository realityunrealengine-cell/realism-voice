-- =====================================================================
-- Realism Voice — 0008: значок Tester
--   badge: owner — владелец (единственный), tester — тестировщик, null — нет значка.
--   Значок только визуальный: на права и RLS не влияет. Привязан к id аккаунта,
--   выдаётся через SQL Editor (см. supabase/admin/tester-badge.sql), сам себе не выдать.
-- Скрипт идемпотентен и не меняет значки пользователей: повторный запуск безопасен.
-- =====================================================================

alter table public.profiles
  drop constraint if exists profiles_badge_check;
alter table public.profiles
  add constraint profiles_badge_check check (badge is null or badge in ('owner', 'tester'));

-- Второго владельца база не примет. Если их уже два, скрипт остановится с ошибкой и ничего не изменит.
create unique index if not exists profiles_single_owner
  on public.profiles (badge) where badge = 'owner';

-- Профиль создаёт только триггер регистрации, клиенту вставка и удаление не нужны
revoke insert, delete on public.profiles from authenticated, anon;

-- Второй рубеж: даже если когда-нибудь колонка случайно окажется в списке разрешённых,
-- запрос от имени клиента значок не изменит. SQL Editor и service_role работают под другими ролями.
create or replace function public.profiles_protect_badge()
returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') then
    if (tg_op = 'INSERT' and new.badge is not null)
       or (tg_op = 'UPDATE' and new.badge is distinct from old.badge) then
      raise exception 'Значок назначается только администратором' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.profiles_protect_badge() from public, anon, authenticated;

drop trigger if exists profiles_protect_badge on public.profiles;
create trigger profiles_protect_badge
  before insert or update on public.profiles
  for each row execute function public.profiles_protect_badge();

notify pgrst, 'reload schema';

-- Результат в SQL Editor: одна строка; ожидается owners=1, your_owner=ваш username,
-- owner_index=true, protect_trigger=true и false в четырёх колонках client_*
select
  (select count(*) from public.profiles where badge = 'owner') as owners,
  (select string_agg(username, ', ') from public.profiles where badge = 'owner') as your_owner,
  (select count(*) from public.profiles where badge = 'tester') as testers,
  exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'profiles_single_owner') as owner_index,
  exists (select 1 from pg_trigger where tgname = 'profiles_protect_badge' and not tgisinternal) as protect_trigger,
  has_column_privilege('authenticated', 'public.profiles', 'badge', 'UPDATE') as client_can_update_badge,
  has_column_privilege('anon', 'public.profiles', 'badge', 'UPDATE') as client_anon_can_update_badge,
  has_table_privilege('authenticated', 'public.profiles', 'INSERT') as client_can_insert_profile,
  has_table_privilege('anon', 'public.profiles', 'INSERT') as client_anon_can_insert_profile;
