-- =====================================================================
-- Realism Voice — 0006: значки пользователей (Owner + золотая галочка)
-- Значок привязан к аккаунту, а не к username. Клиент изменить его не может:
-- колонка badge не входит в разрешённые для UPDATE колонки profiles (см. 0003).
-- Выдать значок можно только через SQL Editor или service_role.
-- =====================================================================

alter table public.profiles
  add column if not exists badge text check (badge is null or badge = 'owner');

-- Только если владельца ещё нет: повторный запуск скрипта не выдаст значок тому,
-- кто позже займёт username «realism».
update public.profiles
set badge = 'owner'
where username = 'realism'
  and not exists (select 1 from public.profiles p where p.badge = 'owner');

notify pgrst, 'reload schema';

-- Результат в SQL Editor: должна быть одна строка с вашим аккаунтом
select username, display_name, badge from public.profiles where badge = 'owner';
