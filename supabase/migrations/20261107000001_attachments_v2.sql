-- =====================================================================
-- Realism Voice — 0009: вложения v2 (версия 1.1.0)
--
-- Бесплатный тариф Supabase Free: файл до 50 МБ, хранилище 1 ГБ на ВЕСЬ проект
-- (вместе с аватарками и баннерами), исходящий трафик 5 ГБ в месяц. Миграция:
--   * поднимает лимит ТОЛЬКО бакета attachments с 25 до 50 МБ (аватарки, иконки, баннеры не меняются);
--   * вводит квоты: общий объём вложений, объём на пользователя, суточный объём загрузок,
--     месячный трафик скачиваний на пользователя и на весь проект;
--   * сервер сам выдаёт путь загрузки (reserve_attachment) и проверяет права и квоты;
--   * размер и тип вложения в сообщении берутся из Storage, а не со слов клиента;
--   * скачивание учитывается (request_attachment_download) — так трафик не превысит квоту;
--   * незавершённые и брошенные загрузки находит my_stale_uploads(), клиент их удаляет.
--
-- Совместимость со старыми версиями приложения (1.0.5 и раньше): пока в public.app_limits
-- флаги enforce_reservations и enforce_download_grants = false, старые клиенты продолжают
-- загружать и открывать вложения как раньше. После обновления всех пользователей флаги можно
-- включить (см. supabase/admin/attachment-limits.sql) — тогда квоты станут обязательными для всех.
--
-- Скрипт идемпотентен и ничего не удаляет.
-- =====================================================================

-- ---------- Лимит бакета (только attachments) ----------
update storage.buckets set file_size_limit = 52428800 where id = 'attachments';

-- ---------- Настройки лимитов (одна строка) ----------
create table if not exists public.app_limits (
  id                         boolean primary key default true check (id),
  attachment_max_bytes       bigint  not null default 52428800,    -- 50 МБ: максимум Supabase Free
  attachments_total_bytes    bigint  not null default 734003200,   -- 700 МБ из 1 ГБ (остальное — аватарки, баннеры, запас)
  user_storage_bytes         bigint  not null default 157286400,   -- 150 МБ вложений на пользователя
  user_daily_upload_bytes    bigint  not null default 262144000,   -- 250 МБ загрузок в сутки на пользователя
  egress_month_bytes         bigint  not null default 3758096384,  -- 3.5 ГБ скачиваний в месяц на проект (из 5 ГБ)
  user_month_download_bytes  bigint  not null default 1073741824,  -- 1 ГБ скачиваний в месяц на пользователя
  enforce_reservations       boolean not null default false,
  enforce_download_grants    boolean not null default false,
  updated_at                 timestamptz not null default now()
);
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

-- ---------- Учёт скачиваний (трафик) ----------
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

-- Поиск сообщений по пути вложения (очистка брошенных файлов)
create index if not exists messages_attachments_idx on public.messages using gin (attachments jsonb_path_ops);

-- ---------- Вспомогательные функции ----------
create or replace function public.attachment_limits()
returns public.app_limits language sql stable security definer set search_path = '' as $$
  select l from public.app_limits l where l.id
$$;

-- Размер объекта в Storage (по данным Storage, а не клиента)
create or replace function public.attachment_object_size(p_path text)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce((o.metadata->>'size')::bigint, 0)
  from storage.objects o where o.bucket_id = 'attachments' and o.name = p_path
$$;

create or replace function public.attachments_used_bytes()
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum(coalesce((o.metadata->>'size')::bigint, 0)), 0)::bigint
  from storage.objects o where o.bucket_id = 'attachments'
$$;

create or replace function public.user_attachment_bytes(p_user uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum(coalesce((o.metadata->>'size')::bigint, 0)), 0)::bigint
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

-- Доступ к пути вложения: channels/<channel>/<user>/<file> или dms/<dm>/<user>/<file>
create or replace function public.can_read_attachment_path(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case split_part(p_path, '/', 1)
    when 'channels' then public.can_view_channel(public.try_uuid(split_part(p_path, '/', 2)))
    when 'dms' then public.is_dm_participant(public.try_uuid(split_part(p_path, '/', 2)))
    else false
  end
$$;

-- Разрешение на загрузку объекта в Storage (используется политикой storage.objects)
create or replace function public.attachment_upload_allowed(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select not (select l.enforce_reservations from public.app_limits l where l.id)
      or exists (
        select 1 from public.attachment_uploads u
        where u.path = p_path and u.user_id = auth.uid() and u.expires_at > now() and u.consumed_at is null
      )
$$;

-- Разрешение на чтение (подписанную ссылку) вложения при обязательном учёте трафика
create or replace function public.attachment_read_allowed(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select not (select l.enforce_download_grants from public.app_limits l where l.id)
      -- автор файла и модераторы канала видят объект без учёта (нужно для удаления и очистки)
      or split_part(p_path, '/', 3) = auth.uid()::text
      or (split_part(p_path, '/', 1) = 'channels'
          and public.has_server_role(public.channel_server(public.try_uuid(split_part(p_path, '/', 2))), 'moderator'))
      or exists (
        select 1 from public.attachment_downloads d
        where d.user_id = auth.uid() and d.path = p_path and d.created_at > now() - interval '15 minutes'
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
  v_total bigint;
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

  -- Квоты проверяются по очереди, чтобы параллельные загрузки не превысили их вместе
  perform pg_advisory_xact_lock(hashtext('rv_attachment_quota'));
  delete from public.attachment_uploads u where u.expires_at < now() - interval '1 day';

  select count(*) into v_count from public.attachment_uploads u
  where u.user_id = v_uid and u.expires_at > now() and u.consumed_at is null
    and not exists (select 1 from storage.objects o where o.bucket_id = 'attachments' and o.name = u.path);
  if v_count >= 20 then
    raise exception 'Слишком много незавершённых загрузок. Дождитесь их окончания.' using errcode = 'P0001';
  end if;

  v_total := public.attachments_used_bytes() + public.attachments_pending_bytes(null);
  if v_total + p_size > v_lim.attachments_total_bytes then
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

-- ---------- RPC: разрешение на скачивание (учёт трафика) ----------
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
  select coalesce((o.metadata->>'size')::bigint, 0) into v_size
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
    raise exception 'Месячный лимит трафика бесплатного хранилища Realism Voice исчерпан. Файлы снова станут доступны в начале следующего месяца.'
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
-- Файлы, загруженные более 2 часов назад и не прикреплённые ни к одному сообщению
-- (отменённые, прерванные, отправленные в удалённых позже сообщениях). Клиент удаляет их через Storage API.
create or replace function public.my_stale_uploads()
returns table (path text)
language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
  where o.bucket_id = 'attachments'
    and auth.uid() is not null
    and split_part(o.name, '/', 3) = auth.uid()::text
    and o.created_at < now() - interval '2 hours'
    and not exists (
      select 1 from public.messages m
      where m.attachments @> jsonb_build_array(jsonb_build_object('path', o.name))
    )
  order by o.created_at
  limit 100
$$;

-- ---------- Проверка вложений сообщения (заменяет версию 0002) ----------
-- Путь обязан лежать в папке этого канала/переписки и этого автора, файл обязан существовать в Storage;
-- размер и тип берутся из Storage.
create or replace function public.validate_attachments(p_attachments jsonb, p_prefix text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_out jsonb := '[]'::jsonb;
  v_max bigint := coalesce((select l.attachment_max_bytes from public.app_limits l where l.id), 52428800);
  v_path text;
  v_size bigint;
  v_meta jsonb;
  v_found boolean;
  v_kind text;
  v_folder jsonb;
begin
  if p_attachments is null or jsonb_typeof(p_attachments) <> 'array' then
    return '[]'::jsonb;
  end if;
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
    select o.metadata, true into v_meta, v_found
    from storage.objects o where o.bucket_id = 'attachments' and o.name = v_path;
    if v_found is not true then
      raise exception 'Файл вложения не найден в хранилище. Отправьте его ещё раз.' using errcode = '22023';
    end if;
    v_size := coalesce((v_meta->>'size')::bigint, (v_item->>'size')::numeric::bigint);
    if v_size < 0 or v_size > v_max then
      raise exception 'Вложение больше допустимого размера' using errcode = '22023';
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

-- ---------- Политики Storage для attachments (заменяют версии 0004) ----------
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
    and public.attachment_upload_allowed(name)
  );

-- ---------- Права ----------
revoke execute on function public.attachment_limits() from public, anon;
revoke execute on function public.attachment_object_size(text) from public, anon, authenticated;
revoke execute on function public.attachments_used_bytes() from public, anon, authenticated;
revoke execute on function public.user_attachment_bytes(uuid) from public, anon, authenticated;
revoke execute on function public.attachments_pending_bytes(uuid) from public, anon, authenticated;
revoke execute on function public.validate_attachments(jsonb, text) from public, anon, authenticated;
revoke execute on function public.can_read_attachment_path(text) from public, anon;
revoke execute on function public.attachment_upload_allowed(text) from public, anon;
revoke execute on function public.attachment_read_allowed(text) from public, anon;
revoke execute on function public.reserve_attachment(text, uuid, text, bigint) from public, anon;
revoke execute on function public.request_attachment_download(text) from public, anon;
revoke execute on function public.attachment_usage() from public, anon;
revoke execute on function public.my_stale_uploads() from public, anon;
grant execute on function public.attachment_limits() to authenticated;
grant execute on function public.can_read_attachment_path(text) to authenticated;
grant execute on function public.attachment_upload_allowed(text) to authenticated;
grant execute on function public.attachment_read_allowed(text) to authenticated;
grant execute on function public.reserve_attachment(text, uuid, text, bigint) to authenticated;
grant execute on function public.request_attachment_download(text) to authenticated;
grant execute on function public.attachment_usage() to authenticated;
grant execute on function public.my_stale_uploads() to authenticated;
