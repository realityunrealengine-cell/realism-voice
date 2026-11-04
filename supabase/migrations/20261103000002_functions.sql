-- =====================================================================
-- Realism Voice — 0002: вспомогательные функции, триггеры, RPC
-- Все функции с повышенными правами (security definer) используют
-- пустой search_path и сами проверяют auth.uid() и права.
-- =====================================================================

-- ---------- Утилиты ----------
create or replace function public.try_uuid(p text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

create or replace function public.random_code(p_len integer default 10)
returns text language plpgsql volatile set search_path = '' as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  v_bytes bytea := decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex');
  v_out text := '';
  i integer;
begin
  for i in 0 .. p_len - 1 loop
    v_out := v_out || substr(v_alphabet, (get_byte(v_bytes, i) % char_length(v_alphabet)) + 1, 1);
  end loop;
  return v_out;
end $$;

create or replace function public.require_auth()
returns uuid language plpgsql stable set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null then
    raise exception 'Требуется авторизация' using errcode = '28000';
  end if;
  return v;
end $$;

-- ---------- Права на сервере ----------
create or replace function public.member_role(p_server uuid, p_user uuid default auth.uid())
returns public.server_role language sql stable security definer set search_path = '' as $$
  select sm.role from public.server_members sm where sm.server_id = p_server and sm.user_id = p_user
$$;

create or replace function public.is_server_member(p_server uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.server_members sm where sm.server_id = p_server and sm.user_id = auth.uid())
$$;

create or replace function public.has_server_role(p_server uuid, p_min public.server_role)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select sm.role >= p_min from public.server_members sm
                   where sm.server_id = p_server and sm.user_id = auth.uid()), false)
$$;

create or replace function public.shares_server_with(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.server_members a
    join public.server_members b on b.server_id = a.server_id
    where a.user_id = auth.uid() and b.user_id = p_user
  )
$$;

create or replace function public.can_view_channel(p_channel uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.channels c
    join public.server_members sm on sm.server_id = c.server_id and sm.user_id = auth.uid()
    where c.id = p_channel
      and (
        not c.is_private
        or sm.role >= 'admin'
        or (c.min_role <> 'member' and sm.role >= c.min_role)
        or exists (select 1 from public.channel_allowed_members a
                   where a.channel_id = c.id and a.user_id = auth.uid())
      )
  )
$$;

create or replace function public.can_send_channel(p_channel uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.can_view_channel(p_channel) and exists (
    select 1 from public.channels c
    join public.server_members sm on sm.server_id = c.server_id and sm.user_id = auth.uid()
    where c.id = p_channel and sm.role >= c.send_min_role
  )
$$;

create or replace function public.channel_server(p_channel uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select c.server_id from public.channels c where c.id = p_channel
$$;

-- Доступ к голосовому каналу (используется Edge Function livekit-token)
create or replace function public.voice_access(p_channel uuid)
returns table (can_join boolean, can_speak boolean, user_limit integer, server_id uuid, channel_name text)
language sql stable security definer set search_path = '' as $$
  select
    public.can_view_channel(c.id) as can_join,
    public.can_send_channel(c.id) as can_speak,
    c.user_limit,
    c.server_id,
    c.name
  from public.channels c
  where c.id = p_channel and c.type = 'voice' and auth.uid() is not null
$$;

-- ---------- Личные сообщения и блокировки ----------
create or replace function public.is_blocked_between(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.blocks b
    where (b.blocker_id = p_a and b.blocked_id = p_b) or (b.blocker_id = p_b and b.blocked_id = p_a)
  )
$$;

create or replace function public.are_friends(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and least(f.requester_id, f.addressee_id) = least(p_a, p_b)
      and greatest(f.requester_id, f.addressee_id) = greatest(p_a, p_b)
  )
$$;

create or replace function public.is_dm_participant(p_dm uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.dm_conversations d
    where d.id = p_dm and auth.uid() in (d.user_low, d.user_high)
  )
$$;

create or replace function public.dm_other_user(p_dm uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select case when d.user_low = auth.uid() then d.user_high else d.user_low end
  from public.dm_conversations d
  where d.id = p_dm and auth.uid() in (d.user_low, d.user_high)
$$;

create or replace function public.can_send_dm(p_dm uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_other uuid;
  v_privacy public.dm_privacy;
begin
  if v_me is null then return false; end if;
  v_other := public.dm_other_user(p_dm);
  if v_other is null then return false; end if;
  if public.is_blocked_between(v_me, v_other) then return false; end if;
  select p.allow_dms into v_privacy from public.profiles p where p.id = v_other;
  if v_privacy = 'friends' and not public.are_friends(v_me, v_other) then return false; end if;
  return true;
end $$;

create or replace function public.can_view_message(p_message uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.messages m
    where m.id = p_message
      and ((m.channel_id is not null and public.can_view_channel(m.channel_id))
        or (m.dm_id is not null and public.is_dm_participant(m.dm_id)))
  )
$$;

-- ---------- Realtime Authorization ----------
-- Разрешённые темы приватных каналов Realtime:
--   presence:global       — онлайн-статусы (любой авторизованный)
--   typing:<channel_id>   — индикатор набора в текстовом канале
--   dm:<dm_id>            — индикатор набора в личной переписке
--   voice:<server_id>     — кто сидит в голосовых каналах сервера
create or replace function public.realtime_topic_allowed(p_topic text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null or p_topic is null then return false; end if;
  if p_topic = 'presence:global' then return true; end if;
  if p_topic like 'typing:%' then
    v_id := public.try_uuid(substr(p_topic, 8));
    return v_id is not null and public.can_view_channel(v_id);
  elsif p_topic like 'dm:%' then
    v_id := public.try_uuid(substr(p_topic, 4));
    return v_id is not null and public.is_dm_participant(v_id);
  elsif p_topic like 'voice:%' then
    v_id := public.try_uuid(substr(p_topic, 7));
    return v_id is not null and public.is_server_member(v_id);
  end if;
  return false;
end $$;

-- =====================================================================
-- Триггеры
-- =====================================================================

-- Создание профиля при регистрации (email или OAuth, например Google)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_username text := lower(coalesce(v_meta->>'username', ''));
  v_display text := btrim(coalesce(v_meta->>'display_name', v_meta->>'full_name', v_meta->>'name', ''));
begin
  if v_username !~ '^[a-z0-9_.]{3,32}$'
     or exists (select 1 from public.profiles p where p.username = v_username) then
    v_username := 'user_' || substr(replace(new.id::text, '-', ''), 1, 10);
  end if;
  if char_length(v_display) = 0 then
    v_display := v_username;
  end if;
  insert into public.profiles (id, username, display_name)
  values (new.id, v_username, left(v_display, 32))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Профиль: защита неизменяемых полей
create or replace function public.profiles_before_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.id := old.id;
  new.created_at := old.created_at;
  new.username := lower(btrim(new.username));
  new.display_name := btrim(new.display_name);
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists profiles_before_update on public.profiles;
create trigger profiles_before_update
  before update on public.profiles
  for each row execute function public.profiles_before_update();

-- Каналы и категории: нельзя перенести на другой сервер, категория должна быть того же сервера
create or replace function public.channels_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.server_id := old.server_id;
    new.created_at := old.created_at;
    new.type := old.type;
  end if;
  new.name := btrim(new.name);
  if new.type = 'text' then
    new.name := lower(regexp_replace(new.name, '\s+', '-', 'g'));
    new.user_limit := null;
  end if;
  if new.category_id is not null and not exists (
    select 1 from public.categories c where c.id = new.category_id and c.server_id = new.server_id
  ) then
    raise exception 'Категория принадлежит другому серверу' using errcode = '22023';
  end if;
  if tg_op = 'INSERT' and (select count(*) from public.channels c where c.server_id = new.server_id) >= 200 then
    raise exception 'Достигнут лимит каналов на сервере (200)' using errcode = '54000';
  end if;
  return new;
end $$;

drop trigger if exists channels_guard on public.channels;
create trigger channels_guard
  before insert or update on public.channels
  for each row execute function public.channels_guard();

create or replace function public.categories_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.server_id := old.server_id;
    new.created_at := old.created_at;
  end if;
  new.name := btrim(new.name);
  if tg_op = 'INSERT' and (select count(*) from public.categories c where c.server_id = new.server_id) >= 50 then
    raise exception 'Достигнут лимит категорий (50)' using errcode = '54000';
  end if;
  return new;
end $$;

drop trigger if exists categories_guard on public.categories;
create trigger categories_guard
  before insert or update on public.categories
  for each row execute function public.categories_guard();

-- Извлечение упоминаний @username
create or replace function public.extract_mentions(p_content text, p_server uuid, p_dm uuid)
returns uuid[] language sql stable security definer set search_path = '' as $$
  with names as (
    select distinct lower(m[1]) as username
    from regexp_matches(coalesce(p_content, ''), '@([A-Za-z0-9_.]{3,32})', 'g') as m
    limit 50
  )
  select coalesce(array_agg(p.id), '{}')
  from names n
  join public.profiles p on p.username = n.username
  where (p_server is not null and exists (select 1 from public.server_members sm
                                          where sm.server_id = p_server and sm.user_id = p.id))
     or (p_dm is not null and exists (select 1 from public.dm_conversations d
                                      where d.id = p_dm and p.id in (d.user_low, d.user_high)))
$$;

-- Проверка вложений: путь обязан лежать в папке этого канала/переписки и этого автора
create or replace function public.validate_attachments(p_attachments jsonb, p_prefix text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_item jsonb;
  v_out jsonb := '[]'::jsonb;
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
       or (v_item->>'size')::numeric > 26214400
       or char_length(v_item->>'name') > 200 then
      raise exception 'Некорректное вложение' using errcode = '22023';
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'path', v_item->>'path',
      'name', v_item->>'name',
      'size', (v_item->>'size')::numeric,
      'mime', left(coalesce(v_item->>'mime', 'application/octet-stream'), 100),
      'width', case when jsonb_typeof(v_item->'width') = 'number' then v_item->'width' else null end,
      'height', case when jsonb_typeof(v_item->'height') = 'number' then v_item->'height' else null end
    ));
  end loop;
  return v_out;
end $$;

-- Сообщения: нормализация, антиспам, упоминания, медленный режим
create or replace function public.messages_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_server uuid;
  v_role public.server_role;
  v_slow integer;
  v_count integer;
begin
  if v_uid is not null then
    new.author_id := v_uid;
  end if;
  new.created_at := now();
  new.edited_at := null;
  new.deleted_at := null;
  new.reactions := '{}'::jsonb;
  new.mention_everyone := false;
  new.content := rtrim(coalesce(new.content, ''));

  -- Антиспам: не более 8 сообщений за 10 секунд и 120 за 5 минут
  select count(*) into v_count from public.messages m
  where m.author_id = new.author_id and m.created_at > now() - interval '10 seconds';
  if v_count >= 8 then
    raise exception 'Слишком много сообщений. Подождите несколько секунд.' using errcode = 'P0001';
  end if;
  select count(*) into v_count from public.messages m
  where m.author_id = new.author_id and m.created_at > now() - interval '5 minutes';
  if v_count >= 120 then
    raise exception 'Превышен лимит сообщений. Попробуйте позже.' using errcode = 'P0001';
  end if;

  if new.channel_id is not null then
    if new.kind <> 'default' then
      raise exception 'Недопустимый тип сообщения' using errcode = '22023';
    end if;
    select c.server_id, c.slowmode_seconds into v_server, v_slow
    from public.channels c where c.id = new.channel_id and c.type = 'text';
    if v_server is null then
      raise exception 'Канал не найден или не является текстовым' using errcode = '22023';
    end if;
    v_role := public.member_role(v_server, new.author_id);
    if v_slow > 0 and coalesce(v_role < 'moderator', true) and exists (
      select 1 from public.messages m
      where m.channel_id = new.channel_id and m.author_id = new.author_id
        and m.created_at > now() - make_interval(secs => v_slow)
    ) then
      raise exception 'Включён медленный режим: % сек.', v_slow using errcode = 'P0001';
    end if;
    new.mentions := public.extract_mentions(new.content, v_server, null);
    new.mention_everyone := coalesce(v_role >= 'moderator', false)
                            and new.content ~ '(^|\s)@(everyone|here)(\s|$)';
    new.attachments := public.validate_attachments(
      new.attachments, 'channels/' || new.channel_id::text || '/' || new.author_id::text || '/');
  else
    if new.kind = 'system' then
      raise exception 'Недопустимый тип сообщения' using errcode = '22023';
    end if;
    new.mentions := public.extract_mentions(new.content, null, new.dm_id);
    new.attachments := public.validate_attachments(
      new.attachments, 'dms/' || new.dm_id::text || '/' || new.author_id::text || '/');
    update public.dm_conversations set last_message_at = now() where id = new.dm_id;
  end if;

  if new.kind = 'default' and char_length(new.content) = 0 and jsonb_array_length(new.attachments) = 0 then
    raise exception 'Пустое сообщение' using errcode = '22023';
  end if;

  if new.reply_to_id is not null and not exists (
    select 1 from public.messages r
    where r.id = new.reply_to_id
      and r.channel_id is not distinct from new.channel_id
      and r.dm_id is not distinct from new.dm_id
  ) then
    new.reply_to_id := null;
  end if;
  return new;
end $$;

drop trigger if exists messages_before_insert on public.messages;
create trigger messages_before_insert
  before insert on public.messages
  for each row execute function public.messages_before_insert();

-- Агрегирование реакций в messages.reactions (чтобы Realtime доставлял их с учётом RLS)
create or replace function public.reactions_sync()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_msg uuid := coalesce(new.message_id, old.message_id);
begin
  update public.messages m
  set reactions = coalesce((
    select jsonb_object_agg(t.emoji, t.users)
    from (
      select r.emoji, jsonb_agg(r.user_id order by r.created_at) as users, min(r.created_at) as first_at
      from public.message_reactions r
      where r.message_id = v_msg
      group by r.emoji
      order by first_at
    ) t
  ), '{}'::jsonb)
  where m.id = v_msg;
  return null;
end $$;

drop trigger if exists reactions_sync on public.message_reactions;
create trigger reactions_sync
  after insert or delete on public.message_reactions
  for each row execute function public.reactions_sync();

create or replace function public.reactions_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.user_id := coalesce(auth.uid(), new.user_id);
  new.created_at := now();
  if exists (select 1 from public.messages m where m.id = new.message_id and m.deleted_at is not null) then
    raise exception 'Сообщение удалено' using errcode = '22023';
  end if;
  if (select count(distinct r.emoji) from public.message_reactions r where r.message_id = new.message_id) >= 20
     and not exists (select 1 from public.message_reactions r where r.message_id = new.message_id and r.emoji = new.emoji) then
    raise exception 'Слишком много разных реакций' using errcode = '54000';
  end if;
  if (select count(*) from public.message_reactions r
      where r.user_id = new.user_id and r.created_at > now() - interval '10 seconds') >= 15 then
    raise exception 'Слишком часто. Подождите.' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists reactions_before_insert on public.message_reactions;
create trigger reactions_before_insert
  before insert on public.message_reactions
  for each row execute function public.reactions_before_insert();

-- =====================================================================
-- RPC: аккаунт
-- =====================================================================
create or replace function public.username_available(p_username text)
returns boolean language sql stable security definer set search_path = '' as $$
  select lower(btrim(p_username)) ~ '^[a-z0-9_.]{3,32}$'
     and not exists (select 1 from public.profiles p where p.username = lower(btrim(p_username)))
$$;

-- =====================================================================
-- RPC: серверы
-- =====================================================================
create or replace function public.create_server(p_name text, p_description text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.require_auth();
  v_server uuid;
  v_text_cat uuid;
  v_voice_cat uuid;
begin
  if (select count(*) from public.servers s where s.owner_id = v_uid and s.created_at > now() - interval '1 day') >= 10 then
    raise exception 'Можно создать не более 10 серверов в сутки' using errcode = 'P0001';
  end if;
  if (select count(*) from public.server_members sm where sm.user_id = v_uid) >= 100 then
    raise exception 'Достигнут лимит серверов (100)' using errcode = '54000';
  end if;
  insert into public.servers (name, description, owner_id)
  values (btrim(p_name), coalesce(btrim(p_description), ''), v_uid)
  returning id into v_server;

  insert into public.server_members (server_id, user_id, role) values (v_server, v_uid, 'owner');

  insert into public.categories (server_id, name, position) values (v_server, 'Текстовые каналы', 0) returning id into v_text_cat;
  insert into public.categories (server_id, name, position) values (v_server, 'Голосовые каналы', 1) returning id into v_voice_cat;
  insert into public.channels (server_id, category_id, name, type, position)
  values (v_server, v_text_cat, 'общий', 'text', 0),
         (v_server, v_voice_cat, 'Общий', 'voice', 0);
  return v_server;
end $$;

create or replace function public.update_server(
  p_server uuid, p_name text, p_description text, p_icon_path text, p_members_can_invite boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_auth();
  if not public.has_server_role(p_server, 'admin') then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  if p_icon_path is not null and left(p_icon_path, 37) <> p_server::text || '/' then
    raise exception 'Некорректный путь иконки' using errcode = '22023';
  end if;
  update public.servers
  set name = btrim(p_name),
      description = coalesce(btrim(p_description), ''),
      icon_path = p_icon_path,
      members_can_invite = coalesce(p_members_can_invite, members_can_invite)
  where id = p_server;
end $$;

create or replace function public.delete_server(p_server uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.servers s where s.id = p_server and s.owner_id = public.require_auth()) then
    raise exception 'Удалить сервер может только владелец' using errcode = '42501';
  end if;
  delete from public.servers where id = p_server;
end $$;

create or replace function public.transfer_ownership(p_server uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.require_auth();
begin
  if not exists (select 1 from public.servers s where s.id = p_server and s.owner_id = v_uid) then
    raise exception 'Только владелец может передать сервер' using errcode = '42501';
  end if;
  if p_user = v_uid or not exists (select 1 from public.server_members sm where sm.server_id = p_server and sm.user_id = p_user) then
    raise exception 'Пользователь не является участником сервера' using errcode = '22023';
  end if;
  update public.servers set owner_id = p_user where id = p_server;
  update public.server_members set role = 'owner' where server_id = p_server and user_id = p_user;
  update public.server_members set role = 'admin' where server_id = p_server and user_id = v_uid;
end $$;

create or replace function public.leave_server(p_server uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.require_auth();
begin
  if exists (select 1 from public.servers s where s.id = p_server and s.owner_id = v_uid) then
    raise exception 'Владелец не может покинуть сервер. Передайте права или удалите сервер.' using errcode = '22023';
  end if;
  delete from public.server_members where server_id = p_server and user_id = v_uid;
  delete from public.channel_allowed_members a
  using public.channels c
  where a.channel_id = c.id and c.server_id = p_server and a.user_id = v_uid;
end $$;

create or replace function public.set_member_role(p_server uuid, p_user uuid, p_role public.server_role)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.require_auth();
  v_my public.server_role := public.member_role(p_server, v_uid);
  v_target public.server_role := public.member_role(p_server, p_user);
begin
  if v_my is null or v_target is null then
    raise exception 'Участник не найден' using errcode = '22023';
  end if;
  if p_role = 'owner' then
    raise exception 'Используйте передачу владения' using errcode = '22023';
  end if;
  -- Нельзя менять роль себе, равным или старшим; нельзя выдавать роль не ниже своей
  if p_user = v_uid or v_my < 'admin' or v_target >= v_my or p_role >= v_my then
    raise exception 'Недостаточно прав для изменения роли' using errcode = '42501';
  end if;
  update public.server_members set role = p_role where server_id = p_server and user_id = p_user;
end $$;

create or replace function public.kick_member(p_server uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.require_auth();
  v_my public.server_role := public.member_role(p_server, v_uid);
  v_target public.server_role := public.member_role(p_server, p_user);
begin
  if v_my is null or v_target is null or v_my < 'moderator' or v_target >= v_my then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  delete from public.server_members where server_id = p_server and user_id = p_user;
end $$;

create or replace function public.ban_member(p_server uuid, p_user uuid, p_reason text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.require_auth();
  v_my public.server_role := public.member_role(p_server, v_uid);
  v_target public.server_role := public.member_role(p_server, p_user);
begin
  if v_my is null or v_my < 'admin' or p_user = v_uid or (v_target is not null and v_target >= v_my) then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  insert into public.server_bans (server_id, user_id, banned_by, reason)
  values (p_server, p_user, v_uid, left(coalesce(p_reason, ''), 300))
  on conflict (server_id, user_id) do update set reason = excluded.reason, banned_by = excluded.banned_by;
  delete from public.server_members where server_id = p_server and user_id = p_user;
end $$;

create or replace function public.unban_member(p_server uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_auth();
  if not public.has_server_role(p_server, 'admin') then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  delete from public.server_bans where server_id = p_server and user_id = p_user;
end $$;

create or replace function public.set_nickname(p_server uuid, p_nickname text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.server_members
  set nickname = nullif(btrim(coalesce(p_nickname, '')), '')
  where server_id = p_server and user_id = public.require_auth();
end $$;

-- Порядок каналов: p_items = [{ "id": uuid, "position": int, "category_id": uuid|null }]
create or replace function public.reorder_channels(p_server uuid, p_items jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_item jsonb;
begin
  perform public.require_auth();
  if not public.has_server_role(p_server, 'admin') then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 200 then
    raise exception 'Некорректные данные' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    update public.channels
    set position = (v_item->>'position')::integer,
        category_id = public.try_uuid(v_item->>'category_id')
    where id = public.try_uuid(v_item->>'id') and server_id = p_server;
  end loop;
end $$;

create or replace function public.reorder_categories(p_server uuid, p_items jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_item jsonb;
begin
  perform public.require_auth();
  if not public.has_server_role(p_server, 'admin') then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 50 then
    raise exception 'Некорректные данные' using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    update public.categories
    set position = (v_item->>'position')::integer
    where id = public.try_uuid(v_item->>'id') and server_id = p_server;
  end loop;
end $$;

create or replace function public.set_channel_allowed_members(p_channel uuid, p_users uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_server uuid := public.channel_server(p_channel);
begin
  perform public.require_auth();
  if v_server is null or not public.has_server_role(v_server, 'admin') then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  delete from public.channel_allowed_members where channel_id = p_channel;
  insert into public.channel_allowed_members (channel_id, user_id)
  select p_channel, sm.user_id
  from public.server_members sm
  where sm.server_id = v_server and sm.user_id = any(coalesce(p_users, '{}'))
  on conflict do nothing;
end $$;

-- =====================================================================
-- RPC: приглашения
-- =====================================================================
create or replace function public.create_invite(p_server uuid, p_max_uses integer default null, p_expires_hours integer default 168)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.require_auth();
  v_role public.server_role := public.member_role(p_server, v_uid);
  v_code text;
  v_can boolean;
begin
  select (v_role >= 'moderator') or s.members_can_invite into v_can from public.servers s where s.id = p_server;
  if v_role is null or not coalesce(v_can, false) then
    raise exception 'Недостаточно прав для создания приглашения' using errcode = '42501';
  end if;
  if (select count(*) from public.invites i where i.created_by = v_uid and i.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Слишком много приглашений. Попробуйте позже.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.invites i where i.server_id = p_server and not i.revoked
      and (i.expires_at is null or i.expires_at > now())) >= 100 then
    raise exception 'Слишком много активных приглашений на сервере' using errcode = '54000';
  end if;
  if p_max_uses is not null and (p_max_uses < 1 or p_max_uses > 1000) then
    raise exception 'Некорректное число использований' using errcode = '22023';
  end if;
  if p_expires_hours is not null and (p_expires_hours < 1 or p_expires_hours > 720) then
    raise exception 'Некорректный срок действия' using errcode = '22023';
  end if;
  loop
    v_code := public.random_code(10);
    exit when not exists (select 1 from public.invites i where i.code = v_code);
  end loop;
  insert into public.invites (code, server_id, created_by, max_uses, expires_at)
  values (v_code, p_server, v_uid, p_max_uses,
          case when p_expires_hours is null then null else now() + make_interval(hours => p_expires_hours) end);
  return v_code;
end $$;

create or replace function public.revoke_invite(p_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.require_auth();
begin
  update public.invites i set revoked = true
  where i.code = p_code and (i.created_by = v_uid or public.has_server_role(i.server_id, 'moderator'));
end $$;

create or replace function public.preview_invite(p_code text)
returns table (server_id uuid, name text, description text, icon_path text, member_count bigint, already_member boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_auth();
  return query
  select s.id, s.name, s.description, s.icon_path,
         (select count(*) from public.server_members sm where sm.server_id = s.id),
         exists (select 1 from public.server_members sm where sm.server_id = s.id and sm.user_id = auth.uid())
  from public.invites i
  join public.servers s on s.id = i.server_id
  where i.code = btrim(p_code) and not i.revoked
    and (i.expires_at is null or i.expires_at > now())
    and (i.max_uses is null or i.uses < i.max_uses);
end $$;

create or replace function public.join_server(p_code text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.require_auth();
  v_inv public.invites%rowtype;
begin
  select * into v_inv from public.invites i where i.code = btrim(p_code) for update;
  if v_inv.code is null or v_inv.revoked
     or (v_inv.expires_at is not null and v_inv.expires_at <= now())
     or (v_inv.max_uses is not null and v_inv.uses >= v_inv.max_uses) then
    raise exception 'Приглашение недействительно или истекло' using errcode = '22023';
  end if;
  if exists (select 1 from public.server_bans b where b.server_id = v_inv.server_id and b.user_id = v_uid) then
    raise exception 'Вы заблокированы на этом сервере' using errcode = '42501';
  end if;
  if exists (select 1 from public.server_members sm where sm.server_id = v_inv.server_id and sm.user_id = v_uid) then
    return v_inv.server_id;
  end if;
  if (select count(*) from public.server_members sm where sm.user_id = v_uid) >= 100 then
    raise exception 'Достигнут лимит серверов (100)' using errcode = '54000';
  end if;
  if (select count(*) from public.server_members sm where sm.server_id = v_inv.server_id) >= 5000 then
    raise exception 'Сервер переполнен' using errcode = '54000';
  end if;
  insert into public.server_members (server_id, user_id, role) values (v_inv.server_id, v_uid, 'member');
  update public.invites set uses = uses + 1 where code = v_inv.code;
  return v_inv.server_id;
end $$;

-- =====================================================================
-- RPC: сообщения
-- =====================================================================
create or replace function public.edit_message(p_message uuid, p_content text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.require_auth();
  v_msg public.messages%rowtype;
  v_content text := rtrim(coalesce(p_content, ''));
begin
  select * into v_msg from public.messages m where m.id = p_message;
  if v_msg.id is null or v_msg.author_id <> v_uid or v_msg.deleted_at is not null or v_msg.kind <> 'default' then
    raise exception 'Редактировать можно только свои сообщения' using errcode = '42501';
  end if;
  if char_length(v_content) > 4000 or (char_length(v_content) = 0 and jsonb_array_length(v_msg.attachments) = 0) then
    raise exception 'Некорректный текст сообщения' using errcode = '22023';
  end if;
  update public.messages
  set content = v_content,
      edited_at = now(),
      mentions = public.extract_mentions(v_content, public.channel_server(v_msg.channel_id), v_msg.dm_id)
  where id = p_message;
end $$;

create or replace function public.delete_message(p_message uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.require_auth();
  v_msg public.messages%rowtype;
  v_allowed boolean;
begin
  select * into v_msg from public.messages m where m.id = p_message;
  if v_msg.id is null or v_msg.deleted_at is not null then
    return;
  end if;
  v_allowed := v_msg.author_id = v_uid
    or (v_msg.channel_id is not null
        and public.can_view_channel(v_msg.channel_id)
        and public.has_server_role(public.channel_server(v_msg.channel_id), 'moderator')
        and coalesce(public.member_role(public.channel_server(v_msg.channel_id), v_msg.author_id), 'member')
            < public.member_role(public.channel_server(v_msg.channel_id), v_uid));
  if not v_allowed then
    raise exception 'Недостаточно прав для удаления' using errcode = '42501';
  end if;
  delete from public.message_reactions where message_id = p_message;
  update public.messages
  set deleted_at = now(), content = '', attachments = '[]'::jsonb, mentions = '{}',
      mention_everyone = false, reactions = '{}'::jsonb
  where id = p_message;
end $$;

create or replace function public.mark_read(p_scope uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.require_auth();
begin
  if not (public.can_view_channel(p_scope) or public.is_dm_participant(p_scope)) then
    return;
  end if;
  insert into public.read_states (user_id, scope_id, last_read_at)
  values (v_uid, p_scope, now())
  on conflict (user_id, scope_id) do update set last_read_at = excluded.last_read_at;
end $$;

create or replace function public.get_unread_counts()
returns table (scope_id uuid, server_id uuid, unread integer, mentions integer, last_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.id, c.server_id,
         count(m.id)::integer,
         count(m.id) filter (where auth.uid() = any (m.mentions) or m.mention_everyone)::integer,
         max(m.created_at)
  from public.channels c
  join public.server_members sm on sm.server_id = c.server_id and sm.user_id = auth.uid()
  left join public.read_states r on r.user_id = auth.uid() and r.scope_id = c.id
  join public.messages m on m.channel_id = c.id
       and m.created_at > coalesce(r.last_read_at, sm.joined_at)
       and m.author_id <> auth.uid()
       and m.deleted_at is null
  where c.type = 'text' and public.can_view_channel(c.id)
  group by c.id, c.server_id
  union all
  select d.id, null::uuid, count(m.id)::integer, count(m.id)::integer, max(m.created_at)
  from public.dm_conversations d
  left join public.read_states r on r.user_id = auth.uid() and r.scope_id = d.id
  join public.messages m on m.dm_id = d.id
       and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
       and m.author_id <> auth.uid()
       and m.deleted_at is null
  where auth.uid() in (d.user_low, d.user_high)
    and not exists (select 1 from public.blocks b
                    where b.blocker_id = auth.uid()
                      and b.blocked_id = case when d.user_low = auth.uid() then d.user_high else d.user_low end)
  group by d.id
$$;

-- =====================================================================
-- RPC: друзья, блокировки, личные сообщения
-- =====================================================================
create or replace function public.send_friend_request(p_username text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.require_auth();
  v_target public.profiles%rowtype;
  v_existing public.friendships%rowtype;
begin
  select * into v_target from public.profiles p where p.username = lower(btrim(p_username));
  if v_target.id is null then
    raise exception 'Пользователь не найден' using errcode = 'P0002';
  end if;
  if v_target.id = v_uid then
    raise exception 'Нельзя добавить себя в друзья' using errcode = '22023';
  end if;
  if public.is_blocked_between(v_uid, v_target.id) then
    raise exception 'Невозможно отправить заявку этому пользователю' using errcode = '42501';
  end if;
  select * into v_existing from public.friendships f
  where least(f.requester_id, f.addressee_id) = least(v_uid, v_target.id)
    and greatest(f.requester_id, f.addressee_id) = greatest(v_uid, v_target.id);
  if v_existing.id is not null then
    if v_existing.status = 'accepted' then
      return 'already_friends';
    elsif v_existing.requester_id = v_uid then
      return 'already_sent';
    else
      update public.friendships set status = 'accepted', accepted_at = now() where id = v_existing.id;
      return 'accepted';
    end if;
  end if;
  if not v_target.allow_friend_requests and not public.shares_server_with(v_target.id) then
    raise exception 'Пользователь не принимает заявки в друзья' using errcode = '42501';
  end if;
  if (select count(*) from public.friendships f
      where f.requester_id = v_uid and f.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Слишком много заявок. Попробуйте позже.' using errcode = 'P0001';
  end if;
  insert into public.friendships (requester_id, addressee_id) values (v_uid, v_target.id);
  return 'sent';
end $$;

create or replace function public.respond_friend_request(p_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.require_auth();
begin
  if p_accept then
    update public.friendships set status = 'accepted', accepted_at = now()
    where id = p_id and addressee_id = v_uid and status = 'pending';
  else
    delete from public.friendships
    where id = p_id and status = 'pending' and (addressee_id = v_uid or requester_id = v_uid);
  end if;
end $$;

create or replace function public.remove_friend(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.require_auth();
begin
  delete from public.friendships f
  where least(f.requester_id, f.addressee_id) = least(v_uid, p_user)
    and greatest(f.requester_id, f.addressee_id) = greatest(v_uid, p_user);
end $$;

create or replace function public.block_user(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.require_auth();
begin
  if p_user = v_uid then
    raise exception 'Нельзя заблокировать себя' using errcode = '22023';
  end if;
  insert into public.blocks (blocker_id, blocked_id) values (v_uid, p_user) on conflict do nothing;
  perform public.remove_friend(p_user);
end $$;

create or replace function public.unblock_user(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.blocks where blocker_id = public.require_auth() and blocked_id = p_user;
end $$;

create or replace function public.open_dm(p_user uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.require_auth();
  v_low uuid := least(v_uid, p_user);
  v_high uuid := greatest(v_uid, p_user);
  v_id uuid;
  v_privacy public.dm_privacy;
begin
  if p_user = v_uid or not exists (select 1 from public.profiles p where p.id = p_user) then
    raise exception 'Пользователь не найден' using errcode = 'P0002';
  end if;
  select d.id into v_id from public.dm_conversations d where d.user_low = v_low and d.user_high = v_high;
  if v_id is not null then
    return v_id;
  end if;
  if public.is_blocked_between(v_uid, p_user) then
    raise exception 'Невозможно начать переписку с этим пользователем' using errcode = '42501';
  end if;
  select p.allow_dms into v_privacy from public.profiles p where p.id = p_user;
  if v_privacy = 'friends' and not public.are_friends(v_uid, p_user) then
    raise exception 'Пользователь принимает сообщения только от друзей' using errcode = '42501';
  end if;
  if (select count(*) from public.dm_conversations d
      where v_uid in (d.user_low, d.user_high) and d.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Слишком много новых переписок. Попробуйте позже.' using errcode = 'P0001';
  end if;
  insert into public.dm_conversations (user_low, user_high) values (v_low, v_high)
  on conflict (user_low, user_high) do update set user_low = excluded.user_low
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.dm_call_access(p_dm uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_dm_participant(p_dm) and public.can_send_dm(p_dm)
$$;
