-- =====================================================================
-- Realism Voice — 0009: вложения v2 (версия 1.1.x), ревизия 2
--
-- Бесплатный тариф Supabase Free: файл до 50 МБ, хранилище 1 ГБ на ВЕСЬ проект
-- (вместе с аватарками и баннерами), исходящий трафик 5 ГБ в месяц.
--
-- Что делает миграция:
--   * бакет attachments: приватный, 50 МБ на файл, БЕЗ ограничения типов (allowed_mime_types = null);
--     другие бакеты (аватарки, иконки, баннеры) не меняются;
--   * квоты: объём вложений проекта, весь Storage проекта, объём на пользователя, загрузки за сутки,
--     число незавершённых загрузок, скачивания пользователя и проекта за месяц;
--   * путь загрузки выдаёт сервер (reserve_attachment) после проверки прав и квот;
--   * ФАКТИЧЕСКИЙ размер файла сверяется с резервом и квотами в политике INSERT на storage.objects.
--     Supabase Storage после записи файла повторяет проверку политики от имени пользователя с
--     реальными метаданными (metadata.size), поэтому «зарезервировать 1 КБ и загрузить 50 МБ» нельзя;
--   * второй рубеж: validate_attachments не прикрепит к сообщению файл больше резерва или без резерва
--     (когда резервы обязательны); размер и тип берутся из Storage, а не от клиента;
--   * учёт скачиваний (request_attachment_download) — ОЦЕНКА трафика, а не точный счётчик (см. ниже);
--   * поиск брошенных загрузок (my_stale_uploads).
--
-- Честно об ограничениях:
--   * Учёт скачиваний считает выдачу разрешений, а не реальные байты: подписанной ссылкой можно
--     воспользоваться несколько раз, пока она действует; кэш и частичные загрузки видео дают
--     расхождения в обе стороны; аватарки и баннеры (публичные бакеты) не учитываются.
--     Квоты снижают риск превышения бесплатного трафика, но не гарантируют его отсутствие —
--     следите за Usage в панели Supabase.
--   * Квоты объёма проверяются в момент загрузки. Параллельные загрузки разных пользователей
--     могут превысить общий лимит не более чем на несколько файлов по 50 МБ.
--
-- Совместимость: пока enforce_reservations и enforce_download_grants = false, версии 1.0.x
-- загружают и открывают вложения как раньше (но квоты объёма проверяются и для них).
-- Существующие сообщения и файлы не изменяются.
--
-- Скрипт идемпотентен, ничего не удаляет, применяется поверх предыдущей ревизии этого файла.
-- =====================================================================

-- ---------- Бакет attachments ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 52428800, null)
on conflict (id) do update
  set public = false,
      file_size_limit = 52428800,
      allowed_mime_types = null;

-- ---------- Настройки лимитов (одна строка) ----------
create table if not exists public.app_limits (
  id                         boolean primary key default true check (id),
  attachment_max_bytes       bigint  not null default 52428800,    -- 50 МБ: максимум Supabase Free
  attachments_total_bytes    bigint  not null default 734003200,   -- 700 МБ на все вложения
  user_storage_bytes         bigint  not null default 157286400,   -- 150 МБ вложений на пользователя
  user_daily_upload_bytes    bigint  not null default 262144000,   -- 250 МБ загрузок в сутки на пользователя
  egress_month_bytes         bigint  not null default 3758096384,  -- 3,5 ГБ выданных скачиваний в месяц на проект
  user_month_download_bytes  bigint  not null default 1073741824,  -- 1 ГБ выданных скачиваний в месяц на пользователя
  enforce_reservations       boolean not null default false,
  enforce_download_grants    boolean not null default false,
  updated_at                 timestamptz not null default now()
);
-- Ревизия 2: весь Storage проекта (все бакеты) и число незавершённых загрузок
alter table public.app_limits add column if not exists project_storage_bytes bigint not null default 943718400; -- 900 МБ из 1 ГБ
alter table public.app_limits add column if not exists max_pending_uploads integer not null default 5;
insert into public.app_limits (id) values (true) on conflict (id) do nothing;
alter table public.app_limits enable row level security;
drop policy if exists app_limits_read on public.app_limits;
create policy app_limits_read on public.app_limits for select to authenticated using (true);
revoke insert, update, delete, truncate on public.app_limits from anon, authenticated;

-- ---------- Резервирование загрузок ----------
create table if not exists public.attachment_uploads (
  path          text primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  scope_kind    text not null check (scope_kind in ('channel', 'dm')),
  scope_id      uuid not null,
  declared_size bigint not null check (declared_size > 0),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '6 hours'
);
-- Резерв не удаляется после отправки, а помечается: суточная квота учитывает и завершённые загрузки
alter table public.attachment_uploads add column if not exists consumed_at timestamptz;
create index if not exists attachment_uploads_user_idx on public.attachment_uploads (user_id, created_at);
create index if not exists attachment_uploads_expires_idx on public.attachment_uploads (expires_at);
alter table public.attachment_uploads enable row level security;
drop policy if exists attachment_uploads_own on public.attachment_uploads;
create policy attachment_uploads_own on public.attachment_uploads
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete, truncate on public.attachment_uploads from anon, authenticated;

-- ---------- Учёт скачиваний (оценка трафика) ----------
create table if not exists public.attachment_downloads (
  id         bigserial primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  path       text not null,
  bytes      bigint not null check (bytes >= 0),
  created_at timestamptz not null default now()
);
create index if not exists attachment_downloads_user_idx on public.attachment_downloads (user_id, created_at);
create index if not exists attachment_downloads_time_idx on public.attachment_downloads (created_at);
create index if not exists attachment_downloads_path_idx on public.attachment_downloads (user_id, path, created_at);
alter table public.attachment_downloads enable row level security;
drop policy if exists attachment_downloads_own on public.attachment_downloads;
create policy attachment_downloads_own on public.attachment_downloads
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete, truncate on public.attachment_downloads from anon, authenticated;

-- Поиск сообщений по пути вложения (очистка брошенных файлов, проверка «файл прикреплён»)
create index if not exists messages_attachments_idx on public.messages using gin (attachments jsonb_path_ops);

-- ---------- Вспомогательные функции ----------
create or replace function public.attachment_limits()
returns public.app_limits language sql stable security definer set search_path = '' as $$
  select l from public.app_limits l where l.id
$$;

-- Размер из метаданных Storage: metadata.size (после записи), contentLength (заявлен до записи)
create or replace function public.storage_meta_size(p_meta jsonb)
returns bigint language sql immutable set search_path = '' as $$
  select case
    when p_meta is null then null
    when jsonb_typeof(p_meta->'size') = 'number' then (p_meta->>'size')::numeric::bigint
    when jsonb_typeof(p_meta->'contentLength') = 'number' then (p_meta->>'contentLength')::numeric::bigint
    when (p_meta->>'size') ~ '^[0-9]+$' then (p_meta->>'size')::bigint
    when (p_meta->>'contentLength') ~ '^[0-9]+$' then (p_meta->>'contentLength')::bigint
    else null
  end
$$;

create or replace function public.attachment_object_size(p_path text)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(public.storage_meta_size(o.metadata), 0)
  from storage.objects o where o.bucket_id = 'attachments' and o.name = p_path
$$;

create or replace function public.attachments_used_bytes()
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum(coalesce(public.storage_meta_size(o.metadata), 0)), 0)::bigint
  from storage.objects o where o.bucket_id = 'attachments'
$$;

-- Весь Storage проекта (все бакеты): именно он ограничен 1 ГБ на тарифе Free
create or replace function public.storage_used_bytes()
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum(coalesce(public.storage_meta_size(o.metadata), 0)), 0)::bigint
  from storage.objects o
$$;

create or replace function public.user_attachment_bytes(p_user uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum(coalesce(public.storage_meta_size(o.metadata), 0)), 0)::bigint
  from storage.objects o
  where o.bucket_id = 'attachments' and split_part(o.name, '/', 3) = p_user::text
$$;

-- Зарезервированный, но ещё не загруженный объём
create or replace function public.attachments_pending_bytes(p_user uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum(u.declared_size), 0)::bigint
  from public.attachment_uploads u
  where u.expires_at > now()
    and u.consumed_at is null
    and (p_user is null or u.user_id = p_user)
    and not exists (select 1 from storage.objects o where o.bucket_id = 'attachments' and o.name = u.path)
$$;

-- Файл прикреплён хотя бы к одному сообщению (удалённые сообщения вложений не хранят)
create or replace function public.attachment_is_referenced(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.messages m
    where m.attachments @> jsonb_build_array(jsonb_build_object('path', p_path))
  )
$$;

-- Доступ к пути вложения: channels/<channel>/<user>/<file> или dms/<dm>/<user>/<file>
create or replace function public.can_read_attachment_path(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case split_part(p_path, '/', 1)
    when 'channels' then public.can_view_channel(public.try_uuid(split_part(p_path, '/', 2)))
    when 'dms' then public.is_dm_participant(public.try_uuid(split_part(p_path, '/', 2)))
    else false
  end
$$;

-- Разрешение на запись объекта в Storage (вызывается политикой INSERT).
-- Storage проверяет политику дважды: до загрузки (размер, заявленный клиентом) и после записи файла
-- (реальный metadata.size). Обе проверки должны пройти.
create or replace function public.attachment_upload_allowed(p_path text, p_meta jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_lim public.app_limits;
  v_res public.attachment_uploads;
  v_size bigint := public.storage_meta_size(p_meta);
  v_existing bigint;
begin
  if v_uid is null then return false; end if;
  select * into v_lim from public.app_limits l where l.id;
  select * into v_res from public.attachment_uploads u
  where u.path = p_path and u.user_id = v_uid and u.consumed_at is null and u.expires_at > now();

  if v_res.path is null and v_lim.enforce_reservations then
    return false;
  end if;
  if v_size is null then
    -- Размер ещё неизвестен (проверка прав до загрузки): решит повторная проверка после записи
    return true;
  end if;
  if v_size > v_lim.attachment_max_bytes then return false; end if;
  -- Фактический размер не может превышать резерв
  if v_res.path is not null and v_size > v_res.declared_size then return false; end if;
  -- Квоты объёма — для всех загрузок, включая старые версии приложения без резерва.
  -- Резерв этого же файла уже учтён в «ожидающих» байтах, поэтому вычитается.
  v_existing := coalesce(public.attachment_object_size(p_path), 0);
  if public.user_attachment_bytes(v_uid) - v_existing + v_size > v_lim.user_storage_bytes then return false; end if;
  if public.attachments_used_bytes() - v_existing + v_size > v_lim.attachments_total_bytes then return false; end if;
  if public.storage_used_bytes() - v_existing + v_size > v_lim.project_storage_bytes then return false; end if;
  return true;
end $$;

-- Разрешение на чтение (подписанную ссылку) вложения, когда учёт скачиваний обязателен.
-- Без разрешения автор и модераторы канала видят только НЕприкреплённые файлы (отменённые загрузки,
-- файлы удалённых сообщений) — это нужно, чтобы их удалить. Прикреплённые файлы любой участник,
-- включая автора, открывает только через request_attachment_download.
create or replace function public.attachment_read_allowed(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select not (select l.enforce_download_grants from public.app_limits l where l.id)
      or exists (
        select 1 from public.attachment_downloads d
        where d.user_id = auth.uid() and d.path = p_path and d.created_at > now() - interval '15 minutes'
      )
      or (
        (split_part(p_path, '/', 3) = auth.uid()::text
          or (split_part(p_path, '/', 1) = 'channels'
              and public.has_server_role(public.channel_server(public.try_uuid(split_part(p_path, '/', 2))), 'moderator')))
        and not public.attachment_is_referenced(p_path)
      )
$$;

-- ---------- RPC: резервирование загрузки ----------
create or replace function public.reserve_attachment(p_scope_kind text, p_scope_id uuid, p_name text, p_size bigint)
returns table (path text, max_bytes bigint)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_lim public.app_limits;
  v_safe text;
  v_path text;
  v_count integer;
  v_pending_all bigint;
  v_user bigint;
  v_day bigint;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация' using errcode = '28000';
  end if;
  select * into v_lim from public.app_limits l where l.id;
  if p_size is null or p_size <= 0 then
    raise exception 'Пустой файл отправить нельзя' using errcode = '22023';
  end if;
  if p_size > v_lim.attachment_max_bytes then
    raise exception 'Файл больше % МБ — это максимум бесплатного тарифа хранилища', v_lim.attachment_max_bytes / 1048576
      using errcode = '22023';
  end if;
  if p_scope_kind = 'channel' then
    if not public.can_send_channel(p_scope_id) then
      raise exception 'Нет права отправлять файлы в этот канал' using errcode = '42501';
    end if;
  elsif p_scope_kind = 'dm' then
    if not public.can_send_dm(p_scope_id) then
      raise exception 'Нельзя отправить файл в эту переписку' using errcode = '42501';
    end if;
  else
    raise exception 'Некорректная переписка' using errcode = '22023';
  end if;

  -- Квоты проверяются по очереди, чтобы параллельные резервы не превысили их вместе
  perform pg_advisory_xact_lock(hashtext('rv_attachment_quota'));
  delete from public.attachment_uploads u where u.expires_at < now() - interval '1 day';

  select count(*) into v_count from public.attachment_uploads u
  where u.user_id = v_uid and u.expires_at > now() and u.consumed_at is null
    and not exists (select 1 from storage.objects o where o.bucket_id = 'attachments' and o.name = u.path);
  if v_count >= v_lim.max_pending_uploads then
    raise exception 'Слишком много незавершённых загрузок. Дождитесь их окончания.' using errcode = 'P0001';
  end if;

  v_pending_all := public.attachments_pending_bytes(null);
  if public.attachments_used_bytes() + v_pending_all + p_size > v_lim.attachments_total_bytes
     or public.storage_used_bytes() + v_pending_all + p_size > v_lim.project_storage_bytes then
    raise exception 'Общее хранилище файлов Realism Voice заполнено (лимит бесплатного тарифа). Удалите старые вложения или попробуйте позже.'
      using errcode = 'P0001';
  end if;

  v_user := public.user_attachment_bytes(v_uid) + public.attachments_pending_bytes(v_uid);
  if v_user + p_size > v_lim.user_storage_bytes then
    raise exception 'Ваш лимит хранения вложений (% МБ) исчерпан. Удалите старые сообщения с файлами.', v_lim.user_storage_bytes / 1048576
      using errcode = 'P0001';
  end if;

  select coalesce(sum(u.declared_size), 0) into v_day from public.attachment_uploads u
  where u.user_id = v_uid and u.created_at > now() - interval '1 day';
  if v_day + p_size > v_lim.user_daily_upload_bytes then
    raise exception 'Суточный лимит загрузок (% МБ) исчерпан. Попробуйте завтра.', v_lim.user_daily_upload_bytes / 1048576
      using errcode = 'P0001';
  end if;

  v_safe := left(regexp_replace(coalesce(p_name, ''), '[^A-Za-z0-9._-]+', '_', 'g'), 80);
  v_safe := regexp_replace(v_safe, '^[._]+', '');
  if char_length(v_safe) = 0 then v_safe := 'file'; end if;
  v_path := (case when p_scope_kind = 'channel' then 'channels' else 'dms' end)
            || '/' || p_scope_id::text || '/' || v_uid::text || '/' || gen_random_uuid()::text || '-' || v_safe;

  insert into public.attachment_uploads (path, user_id, scope_kind, scope_id, declared_size)
  values (v_path, v_uid, p_scope_kind, p_scope_id, p_size);

  return query select v_path, v_lim.attachment_max_bytes;
end $$;

-- ---------- RPC: разрешение на скачивание (оценка трафика) ----------
create or replace function public.request_attachment_download(p_path text)
returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_lim public.app_limits;
  v_size bigint;
  v_user_month bigint;
  v_month bigint;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация' using errcode = '28000';
  end if;
  if p_path is null or position('..' in p_path) > 0 or not public.can_read_attachment_path(p_path) then
    raise exception 'Нет доступа к файлу' using errcode = '42501';
  end if;
  select coalesce(public.storage_meta_size(o.metadata), 0) into v_size
  from storage.objects o where o.bucket_id = 'attachments' and o.name = p_path;
  if not found then
    raise exception 'Файл удалён или ещё не загружен' using errcode = 'P0002';
  end if;
  -- Повторный запрос того же файла в течение 15 минут не учитывается второй раз
  if exists (select 1 from public.attachment_downloads d
             where d.user_id = v_uid and d.path = p_path and d.created_at > now() - interval '15 minutes') then
    return v_size;
  end if;

  select * into v_lim from public.app_limits l where l.id;
  perform pg_advisory_xact_lock(hashtext('rv_attachment_egress'));
  delete from public.attachment_downloads d where d.created_at < now() - interval '62 days';

  select coalesce(sum(d.bytes), 0) into v_user_month from public.attachment_downloads d
  where d.user_id = v_uid and d.created_at >= date_trunc('month', now());
  if v_user_month + v_size > v_lim.user_month_download_bytes then
    raise exception 'Ваш месячный лимит скачивания файлов (% МБ) исчерпан', v_lim.user_month_download_bytes / 1048576
      using errcode = 'P0001';
  end if;
  select coalesce(sum(d.bytes), 0) into v_month from public.attachment_downloads d
  where d.created_at >= date_trunc('month', now());
  if v_month + v_size > v_lim.egress_month_bytes then
    raise exception 'Месячный лимит скачиваний Realism Voice исчерпан. Файлы снова станут доступны в начале следующего месяца.'
      using errcode = 'P0001';
  end if;

  insert into public.attachment_downloads (user_id, path, bytes) values (v_uid, p_path, v_size);
  return v_size;
end $$;

-- ---------- RPC: использование квот (для интерфейса) ----------
create or replace function public.attachment_usage()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_lim public.app_limits;
begin
  if v_uid is null then return null; end if;
  select * into v_lim from public.app_limits l where l.id;
  return jsonb_build_object(
    'max_file', v_lim.attachment_max_bytes,
    'total_used', public.attachments_used_bytes(),
    'total_limit', v_lim.attachments_total_bytes,
    'user_used', public.user_attachment_bytes(v_uid),
    'user_limit', v_lim.user_storage_bytes,
    'day_used', (select coalesce(sum(u.declared_size), 0) from public.attachment_uploads u
                 where u.user_id = v_uid and u.created_at > now() - interval '1 day'),
    'day_limit', v_lim.user_daily_upload_bytes,
    'month_download_used', (select coalesce(sum(d.bytes), 0) from public.attachment_downloads d
                            where d.user_id = v_uid and d.created_at >= date_trunc('month', now())),
    'month_download_limit', v_lim.user_month_download_bytes
  );
end $$;

-- ---------- RPC: брошенные загрузки пользователя ----------
create or replace function public.my_stale_uploads()
returns table (path text)
language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
  where o.bucket_id = 'attachments'
    and auth.uid() is not null
    and split_part(o.name, '/', 3) = auth.uid()::text
    and o.created_at < now() - interval '2 hours'
    and not public.attachment_is_referenced(o.name)
  order by o.created_at
  limit 100
$$;

-- ---------- Проверка вложений нового сообщения (заменяет версию 0002) ----------
-- Вызывается только при INSERT сообщения; существующие сообщения не перепроверяются и не меняются.
create or replace function public.validate_attachments(p_attachments jsonb, p_prefix text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_out jsonb := '[]'::jsonb;
  v_lim public.app_limits;
  v_max bigint;
  v_path text;
  v_size bigint;
  v_meta jsonb;
  v_found boolean;
  v_res public.attachment_uploads;
  v_kind text;
  v_folder jsonb;
begin
  if p_attachments is null or jsonb_typeof(p_attachments) <> 'array' then
    return '[]'::jsonb;
  end if;
  select * into v_lim from public.app_limits l where l.id;
  v_max := coalesce(v_lim.attachment_max_bytes, 52428800);
  for v_item in select * from jsonb_array_elements(p_attachments) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item->'path') <> 'string'
       or jsonb_typeof(v_item->'name') <> 'string'
       or jsonb_typeof(v_item->'size') <> 'number'
       or left(v_item->>'path', char_length(p_prefix)) <> p_prefix
       or position('..' in v_item->>'path') > 0
       or position('/' in substr(v_item->>'path', char_length(p_prefix) + 1)) > 0
       or char_length(v_item->>'name') > 200
       or char_length(v_item->>'name') = 0 then
      raise exception 'Некорректное вложение' using errcode = '22023';
    end if;
    v_path := v_item->>'path';
    v_meta := null;
    v_found := null;
    select o.metadata, true into v_meta, v_found
    from storage.objects o where o.bucket_id = 'attachments' and o.name = v_path;
    if v_found is not true then
      raise exception 'Файл вложения не найден в хранилище. Отправьте его ещё раз.' using errcode = '22023';
    end if;
    v_size := public.storage_meta_size(v_meta);
    select * into v_res from public.attachment_uploads u where u.path = v_path;
    if v_lim.enforce_reservations and (v_res.path is null or v_size is null) then
      raise exception 'Файл загружен без резерва. Отправьте его ещё раз.' using errcode = '22023';
    end if;
    v_size := coalesce(v_size, (v_item->>'size')::numeric::bigint);
    if v_size < 0 or v_size > v_max then
      raise exception 'Вложение больше допустимого размера' using errcode = '22023';
    end if;
    if v_res.path is not null and v_size > v_res.declared_size then
      raise exception 'Размер файла не совпадает с заявленным' using errcode = '22023';
    end if;
    v_kind := case when v_item->>'kind' = 'folder' then 'folder' else 'file' end;
    v_folder := null;
    if v_kind = 'folder' and jsonb_typeof(v_item->'folder') = 'object' then
      v_folder := jsonb_build_object(
        'files', least(greatest(coalesce((v_item->'folder'->>'files')::numeric, 0), 0), 100000)::bigint,
        'dirs', least(greatest(coalesce((v_item->'folder'->>'dirs')::numeric, 0), 0), 100000)::bigint,
        'bytes', least(greatest(coalesce((v_item->'folder'->>'bytes')::numeric, 0), 0), 1099511627776)::bigint
      );
    end if;
    v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'path', v_path,
      'name', v_item->>'name',
      'size', v_size,
      'mime', left(case when v_kind = 'folder' then 'application/zip'
                        else coalesce(nullif(v_meta->>'mimetype', ''), v_item->>'mime', 'application/octet-stream') end, 100),
      'width', case when jsonb_typeof(v_item->'width') = 'number' then v_item->'width' else null end,
      'height', case when jsonb_typeof(v_item->'height') = 'number' then v_item->'height' else null end,
      'kind', v_kind,
      'folder', v_folder
    )));
    -- Резерв использован (строка остаётся для суточной квоты и удаляется через сутки)
    update public.attachment_uploads u set consumed_at = now() where u.path = v_path and u.consumed_at is null;
  end loop;
  return v_out;
end $$;

-- ---------- Политики Storage для attachments (заменяют версии 0004 и ревизии 1) ----------
drop policy if exists rv_attachments_select on storage.objects;
create policy rv_attachments_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'attachments'
    and public.can_read_attachment_path(name)
    and public.attachment_read_allowed(name)
  );

drop policy if exists rv_attachments_insert on storage.objects;
create policy rv_attachments_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[3] = (select auth.uid())::text
    and array_length(storage.foldername(name), 1) = 3
    and position('..' in name) = 0
    and (
      ((storage.foldername(name))[1] = 'channels'
        and public.can_send_channel(public.try_uuid((storage.foldername(name))[2])))
      or ((storage.foldername(name))[1] = 'dms'
        and public.can_send_dm(public.try_uuid((storage.foldername(name))[2])))
    )
    and public.attachment_upload_allowed(name, metadata)
  );
-- Функция ревизии 1 (без размера) больше не используется
drop function if exists public.attachment_upload_allowed(text);

-- ---------- Права ----------
revoke execute on function public.attachment_limits() from public, anon;
revoke execute on function public.storage_meta_size(jsonb) from public, anon;
revoke execute on function public.attachment_object_size(text) from public, anon, authenticated;
revoke execute on function public.attachments_used_bytes() from public, anon, authenticated;
revoke execute on function public.storage_used_bytes() from public, anon, authenticated;
revoke execute on function public.user_attachment_bytes(uuid) from public, anon, authenticated;
revoke execute on function public.attachments_pending_bytes(uuid) from public, anon, authenticated;
revoke execute on function public.attachment_is_referenced(text) from public, anon;
revoke execute on function public.validate_attachments(jsonb, text) from public, anon, authenticated;
revoke execute on function public.can_read_attachment_path(text) from public, anon;
revoke execute on function public.attachment_upload_allowed(text, jsonb) from public, anon;
revoke execute on function public.attachment_read_allowed(text) from public, anon;
revoke execute on function public.reserve_attachment(text, uuid, text, bigint) from public, anon;
revoke execute on function public.request_attachment_download(text) from public, anon;
revoke execute on function public.attachment_usage() from public, anon;
revoke execute on function public.my_stale_uploads() from public, anon;
grant execute on function public.attachment_limits() to authenticated;
grant execute on function public.storage_meta_size(jsonb) to authenticated;
grant execute on function public.attachment_is_referenced(text) to authenticated;
grant execute on function public.can_read_attachment_path(text) to authenticated;
grant execute on function public.attachment_upload_allowed(text, jsonb) to authenticated;
grant execute on function public.attachment_read_allowed(text) to authenticated;
grant execute on function public.reserve_attachment(text, uuid, text, bigint) to authenticated;
grant execute on function public.request_attachment_download(text) to authenticated;
grant execute on function public.attachment_usage() to authenticated;
grant execute on function public.my_stale_uploads() to authenticated;
