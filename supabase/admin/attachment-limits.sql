-- =====================================================================
-- Realism Voice — квоты вложений (выполнять в Supabase Dashboard → SQL Editor по одному запросу)
-- Требуется миграция 20261107000001_attachments_v2.sql (версия 1.1.0).
-- =====================================================================

-- 1. Текущее использование (только чтение)
select
  pg_size_pretty(public.attachments_used_bytes())                                   as attachments_used,
  pg_size_pretty((select attachments_total_bytes from public.app_limits))           as attachments_limit,
  pg_size_pretty(coalesce((select sum((o.metadata->>'size')::bigint) from storage.objects o), 0)) as all_storage_used,
  pg_size_pretty(coalesce((select sum(d.bytes) from public.attachment_downloads d
                           where d.created_at >= date_trunc('month', now())), 0))  as downloads_this_month,
  pg_size_pretty((select egress_month_bytes from public.app_limits))                as downloads_month_limit;

-- 2. Кто сколько хранит (только чтение)
select p.username, pg_size_pretty(public.user_attachment_bytes(p.id)) as stored
from public.profiles p
order by public.user_attachment_bytes(p.id) desc
limit 20;

-- 3. Сделать квоты обязательными для всех клиентов.
--    Выполнять ПОСЛЕ того, как все пользователи обновились до 1.1.0: старые версии
--    (1.0.5 и раньше) после этого не смогут отправлять и открывать вложения.
update public.app_limits set enforce_reservations = true, enforce_download_grants = true, updated_at = now() where id;

-- 4. Откатить шаг 3
update public.app_limits set enforce_reservations = false, enforce_download_grants = false, updated_at = now() where id;

-- 5. Изменить лимиты (пример). На тарифе Free значение attachment_max_bytes выше 52428800 (50 МБ)
--    не имеет смысла: Supabase всё равно отклонит файл. После перехода на Pro можно поднять лимит
--    и одновременно file_size_limit бакета attachments.
-- update public.app_limits set attachments_total_bytes = 734003200, user_storage_bytes = 157286400, updated_at = now() where id;
