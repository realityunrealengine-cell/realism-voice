-- =====================================================================
-- Realism Voice — выдача и отзыв значка Tester (Supabase Dashboard → SQL Editor)
-- Не миграция: выполняйте по одному шагу, выделяя только нужный запрос.
-- Значок привязан к id аккаунта и переживает смену username.
-- Запросы ниже не изменят ничего, пока вместо заглушки не указан настоящий id.
-- =====================================================================


-- ШАГ 1. Найти аккаунт. Этот запрос только читает данные.
-- Сверьте с другом username и email, а также имя и дату регистрации.
-- Если строк несколько или есть сомнения, не продолжайте.
select p.id, p.username, p.display_name, p.badge, u.email, p.created_at
from public.profiles p
join auth.users u on u.id = p.id
where p.username = lower('USERNAME_ДРУГА');


-- ШАГ 2. Выдать Tester. Вставьте id из шага 1.
-- Должна вернуться одна строка. Ноль строк: неверный id или у аккаунта уже есть значок
-- (Owner этим запросом не заменить). Значок появится у всех без перезапуска, в версии 1.0.5 и новее.
update public.profiles
set badge = 'tester'
where id = 'UUID_ДРУГА'::uuid
  and badge is null
returning id, username, display_name, badge;


-- ШАГ 3. Проверить: все значки в системе. Owner должен быть один.
select id, username, display_name, badge
from public.profiles
where badge is not null
order by badge, username;


-- ОТЗЫВ ЗНАЧКА. Снимает только Tester: значок Owner этим запросом не снять.
-- Должна вернуться одна строка со значением badge, равным null.
update public.profiles
set badge = null
where id = 'UUID_ДРУГА'::uuid
  and badge = 'tester'
returning id, username, display_name, badge;
