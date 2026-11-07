-- =====================================================================
-- Realism Voice — проверка рабочей базы ПЕРЕД применением 20261107000001_attachments_v2.sql
-- Только чтение: ничего не меняет. Выполняйте в SQL Editor и сверяйте с ожидаемым результатом.
-- =====================================================================

-- 1. Настройки бакетов. Ожидается: attachments private (public = false); после миграции —
--    file_size_limit = 52428800 и allowed_mime_types = NULL (любые типы файлов).
--    Если allowed_mime_types сейчас не NULL — отправка части файлов (EXE, ZIP, MKV…) сейчас не работает,
--    миграция это исправит.
select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id;

-- 2. ВСЕ политики на storage.objects. Ожидаются только политики Realism Voice (rv_…).
--    Разрешающие (PERMISSIVE) политики объединяются через OR: любая лишняя политика вида
--    «authenticated может читать/писать всё» сделает ограничения миграции бесполезными.
--    Если есть политики не с префиксом rv_ — пришлите их список до применения миграции.
select policyname, permissive, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by policyname;

-- 3. Текущие вложения: сколько и какого размера (для оценки квот)
select count(*) as attachment_objects,
       pg_size_pretty(coalesce(sum((metadata->>'size')::bigint), 0)) as attachments_size,
       count(*) filter (where metadata is null or metadata->>'size' is null) as without_size_metadata
from storage.objects where bucket_id = 'attachments';

-- 4. Весь Storage проекта (лимит тарифа Free — 1 ГБ на все бакеты)
select bucket_id, count(*) as objects, pg_size_pretty(coalesce(sum((metadata->>'size')::bigint), 0)) as size
from storage.objects group by bucket_id order by bucket_id;

-- 5. Сообщения с вложениями (миграция их не меняет — для сверки до и после)
select count(*) as messages_with_attachments,
       sum(jsonb_array_length(attachments)) as attachments_total
from public.messages where jsonb_array_length(attachments) > 0;

-- 6. Миграция ещё не применялась? (пусто — не применялась; есть строки — применена ревизия 1 или 2)
select table_name from information_schema.tables
where table_schema = 'public' and table_name in ('app_limits', 'attachment_uploads', 'attachment_downloads');

-- 7. Глобальный лимит размера файла проекта виден только в панели:
--    Storage → Settings → Upload file size limit. На тарифе Free он должен быть 50 MB;
--    если он меньше — файлы до 50 МБ всё равно не загрузятся.
