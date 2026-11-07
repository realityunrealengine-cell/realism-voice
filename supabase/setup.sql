-- =====================================================================
-- Realism Voice — полная настройка базы данных (сгенерировано из supabase/migrations)
-- Вставьте целиком в Supabase Dashboard → SQL Editor → Run.
-- Скрипт идемпотентен: повторный запуск безопасен и не удаляет данные.
-- =====================================================================

-- >>> 20261103000001_schema.sql
-- =====================================================================
-- Realism Voice — 0001: типы, таблицы, индексы
-- Скрипт идемпотентен: его можно безопасно выполнить повторно.
-- =====================================================================

-- ---------- Перечисления ----------
do $$ begin
  create type public.server_role as enum ('member', 'moderator', 'admin', 'owner');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.channel_type as enum ('text', 'voice');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.presence_status as enum ('online', 'idle', 'dnd', 'invisible');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.dm_privacy as enum ('everyone', 'friends');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.friendship_status as enum ('pending', 'accepted');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.message_kind as enum ('default', 'call', 'system');
exception when duplicate_object then null; end $$;

-- ---------- Профили ----------
create table if not exists public.profiles (
  id                    uuid primary key references auth.users (id) on delete cascade,
  username              text not null unique check (username ~ '^[a-z0-9_.]{3,32}$'),
  display_name          text not null check (char_length(btrim(display_name)) between 1 and 32),
  avatar_path           text check (avatar_path is null or char_length(avatar_path) <= 300),
  bio                   text not null default '' check (char_length(bio) <= 190),
  custom_status         text not null default '' check (char_length(custom_status) <= 128),
  status                public.presence_status not null default 'online',
  allow_dms             public.dm_privacy not null default 'everyone',
  allow_friend_requests boolean not null default true,
  accent_color          text check (accent_color is null or accent_color ~ '^#[0-9a-fA-F]{6}$'),
  last_seen_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ---------- Серверы ----------
create table if not exists public.servers (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (char_length(btrim(name)) between 2 and 64),
  description        text not null default '' check (char_length(description) <= 300),
  icon_path          text check (icon_path is null or char_length(icon_path) <= 300),
  owner_id           uuid not null references public.profiles (id) on delete cascade,
  members_can_invite boolean not null default true,
  created_at         timestamptz not null default now()
);
create index if not exists servers_owner_idx on public.servers (owner_id, created_at desc);

create table if not exists public.server_members (
  server_id uuid not null references public.servers (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  role      public.server_role not null default 'member',
  nickname  text check (nickname is null or char_length(btrim(nickname)) between 1 and 32),
  joined_at timestamptz not null default now(),
  primary key (server_id, user_id)
);
create index if not exists server_members_user_idx on public.server_members (user_id);

create table if not exists public.server_bans (
  server_id  uuid not null references public.servers (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  banned_by  uuid references public.profiles (id) on delete set null,
  reason     text not null default '' check (char_length(reason) <= 300),
  created_at timestamptz not null default now(),
  primary key (server_id, user_id)
);

create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  server_id  uuid not null references public.servers (id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 48),
  position   integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists categories_server_idx on public.categories (server_id, position);

create table if not exists public.channels (
  id               uuid primary key default gen_random_uuid(),
  server_id        uuid not null references public.servers (id) on delete cascade,
  category_id      uuid references public.categories (id) on delete set null,
  name             text not null check (char_length(btrim(name)) between 1 and 64),
  type             public.channel_type not null default 'text',
  topic            text not null default '' check (char_length(topic) <= 300),
  position         integer not null default 0,
  is_private       boolean not null default false,
  -- Для приватного канала: минимальная роль для просмотра (кроме явно разрешённых участников)
  min_role         public.server_role not null default 'member',
  -- Минимальная роль для отправки сообщений / разговора в голосовом канале
  send_min_role    public.server_role not null default 'member',
  user_limit       integer check (user_limit is null or user_limit between 1 and 99),
  slowmode_seconds integer not null default 0 check (slowmode_seconds between 0 and 21600),
  created_at       timestamptz not null default now()
);
create index if not exists channels_server_idx on public.channels (server_id, position);
create index if not exists channels_category_idx on public.channels (category_id);

create table if not exists public.channel_allowed_members (
  channel_id uuid not null references public.channels (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  primary key (channel_id, user_id)
);
create index if not exists channel_allowed_members_user_idx on public.channel_allowed_members (user_id);

create table if not exists public.invites (
  code       text primary key check (code ~ '^[A-Za-z0-9]{6,16}$'),
  server_id  uuid not null references public.servers (id) on delete cascade,
  created_by uuid references public.profiles (id) on delete set null,
  max_uses   integer check (max_uses is null or max_uses between 1 and 1000),
  uses       integer not null default 0,
  expires_at timestamptz,
  revoked    boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists invites_server_idx on public.invites (server_id);
create index if not exists invites_creator_idx on public.invites (created_by, created_at desc);

-- ---------- Личные переписки ----------
create table if not exists public.dm_conversations (
  id              uuid primary key default gen_random_uuid(),
  user_low        uuid not null references public.profiles (id) on delete cascade,
  user_high       uuid not null references public.profiles (id) on delete cascade,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  check (user_low < user_high),
  unique (user_low, user_high)
);
create index if not exists dm_conversations_high_idx on public.dm_conversations (user_high);

-- ---------- Сообщения ----------
create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),
  channel_id       uuid references public.channels (id) on delete cascade,
  dm_id            uuid references public.dm_conversations (id) on delete cascade,
  author_id        uuid not null references public.profiles (id) on delete cascade,
  kind             public.message_kind not null default 'default',
  content          text not null default '' check (char_length(content) <= 4000),
  reply_to_id      uuid references public.messages (id) on delete set null,
  attachments      jsonb not null default '[]'::jsonb
                   check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 10),
  mentions         uuid[] not null default '{}',
  mention_everyone boolean not null default false,
  reactions        jsonb not null default '{}'::jsonb,
  edited_at        timestamptz,
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  check ((channel_id is null) <> (dm_id is null))
);
create index if not exists messages_channel_idx on public.messages (channel_id, created_at desc) where channel_id is not null;
create index if not exists messages_dm_idx on public.messages (dm_id, created_at desc) where dm_id is not null;
create index if not exists messages_author_idx on public.messages (author_id, created_at desc);
create index if not exists messages_reply_idx on public.messages (reply_to_id) where reply_to_id is not null;

create table if not exists public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  emoji      text not null check (char_length(emoji) between 1 and 32),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index if not exists message_reactions_user_idx on public.message_reactions (user_id, created_at desc);

-- ---------- Друзья и блокировки ----------
create table if not exists public.friendships (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status       public.friendship_status not null default 'pending',
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  check (requester_id <> addressee_id)
);
create unique index if not exists friendships_pair_uidx
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index if not exists friendships_addressee_idx on public.friendships (addressee_id);
create index if not exists friendships_requester_idx on public.friendships (requester_id, created_at desc);

create table if not exists public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists blocks_blocked_idx on public.blocks (blocked_id);

-- ---------- Прочитанность ----------
create table if not exists public.read_states (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  scope_id     uuid not null, -- channels.id или dm_conversations.id
  last_read_at timestamptz not null default now(),
  primary key (user_id, scope_id)
);


-- >>> 20261103000002_functions.sql
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


-- >>> 20261103000003_rls.sql
-- =====================================================================
-- Realism Voice — 0003: Row Level Security
-- Все изменения структурных данных (роли, участники, приглашения, друзья,
-- переписки) выполняются только через RPC из 0002 — прямых политик
-- INSERT/UPDATE/DELETE для них нет.
-- =====================================================================

alter table public.profiles                enable row level security;
alter table public.servers                 enable row level security;
alter table public.server_members          enable row level security;
alter table public.server_bans             enable row level security;
alter table public.categories              enable row level security;
alter table public.channels                enable row level security;
alter table public.channel_allowed_members enable row level security;
alter table public.invites                 enable row level security;
alter table public.dm_conversations        enable row level security;
alter table public.messages                enable row level security;
alter table public.message_reactions       enable row level security;
alter table public.friendships             enable row level security;
alter table public.blocks                  enable row level security;
alter table public.read_states             enable row level security;

-- ---------- profiles ----------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ---------- servers ----------
drop policy if exists servers_select on public.servers;
create policy servers_select on public.servers
  for select to authenticated using (public.is_server_member(id));

-- ---------- server_members ----------
drop policy if exists server_members_select on public.server_members;
create policy server_members_select on public.server_members
  for select to authenticated using (public.is_server_member(server_id));

-- ---------- server_bans ----------
drop policy if exists server_bans_select on public.server_bans;
create policy server_bans_select on public.server_bans
  for select to authenticated using (public.has_server_role(server_id, 'moderator'));

-- ---------- categories ----------
drop policy if exists categories_select on public.categories;
create policy categories_select on public.categories
  for select to authenticated using (public.is_server_member(server_id));

drop policy if exists categories_insert on public.categories;
create policy categories_insert on public.categories
  for insert to authenticated with check (public.has_server_role(server_id, 'admin'));

drop policy if exists categories_update on public.categories;
create policy categories_update on public.categories
  for update to authenticated
  using (public.has_server_role(server_id, 'admin'))
  with check (public.has_server_role(server_id, 'admin'));

drop policy if exists categories_delete on public.categories;
create policy categories_delete on public.categories
  for delete to authenticated using (public.has_server_role(server_id, 'admin'));

-- ---------- channels ----------
drop policy if exists channels_select on public.channels;
create policy channels_select on public.channels
  -- has_server_role проверяется первым: при INSERT ... RETURNING новая строка ещё
  -- не видна функции can_view_channel, а создавать каналы может только admin+.
  for select to authenticated
  using (public.has_server_role(server_id, 'admin') or public.can_view_channel(id));

drop policy if exists channels_insert on public.channels;
create policy channels_insert on public.channels
  for insert to authenticated with check (public.has_server_role(server_id, 'admin'));

drop policy if exists channels_update on public.channels;
create policy channels_update on public.channels
  for update to authenticated
  using (public.has_server_role(server_id, 'admin'))
  with check (public.has_server_role(server_id, 'admin'));

drop policy if exists channels_delete on public.channels;
create policy channels_delete on public.channels
  for delete to authenticated using (public.has_server_role(server_id, 'admin'));

-- ---------- channel_allowed_members ----------
drop policy if exists channel_allowed_select on public.channel_allowed_members;
create policy channel_allowed_select on public.channel_allowed_members
  for select to authenticated
  using (user_id = (select auth.uid()) or public.has_server_role(public.channel_server(channel_id), 'admin'));

-- ---------- invites ----------
drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites
  for select to authenticated
  using (created_by = (select auth.uid()) or public.has_server_role(server_id, 'moderator'));

-- ---------- dm_conversations ----------
drop policy if exists dm_select on public.dm_conversations;
create policy dm_select on public.dm_conversations
  for select to authenticated
  using ((select auth.uid()) in (user_low, user_high));

-- ---------- messages ----------
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages
  for select to authenticated
  using (
    (channel_id is not null and public.can_view_channel(channel_id))
    or (dm_id is not null and public.is_dm_participant(dm_id))
  );

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and (
      (channel_id is not null and public.can_send_channel(channel_id))
      or (dm_id is not null and public.can_send_dm(dm_id))
    )
  );
-- UPDATE/DELETE сообщений — только через edit_message / delete_message.

-- ---------- message_reactions ----------
drop policy if exists reactions_select on public.message_reactions;
create policy reactions_select on public.message_reactions
  for select to authenticated using (public.can_view_message(message_id));

drop policy if exists reactions_insert on public.message_reactions;
create policy reactions_insert on public.message_reactions
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.can_view_message(message_id));

drop policy if exists reactions_delete on public.message_reactions;
create policy reactions_delete on public.message_reactions
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------- friendships ----------
drop policy if exists friendships_select on public.friendships;
create policy friendships_select on public.friendships
  for select to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));

-- ---------- blocks ----------
drop policy if exists blocks_select on public.blocks;
create policy blocks_select on public.blocks
  for select to authenticated using (blocker_id = (select auth.uid()));

-- ---------- read_states ----------
drop policy if exists read_states_all on public.read_states;
create policy read_states_all on public.read_states
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- =====================================================================
-- Привилегии: анонимы не получают доступ к таблицам и RPC
-- =====================================================================
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.username_available(text) to anon;

-- Триггерные функции не должны вызываться напрямую
revoke execute on function public.handle_new_user() from authenticated;
revoke execute on function public.profiles_before_update() from authenticated;
revoke execute on function public.channels_guard() from authenticated;
revoke execute on function public.categories_guard() from authenticated;
revoke execute on function public.messages_before_insert() from authenticated;
revoke execute on function public.reactions_sync() from authenticated;
revoke execute on function public.reactions_before_insert() from authenticated;

-- Колонки профиля, которые клиент может менять (id/created_at/updated_at — нет)
revoke update on public.profiles from authenticated;
grant update (username, display_name, avatar_path, bio, custom_status, status,
              allow_dms, allow_friend_requests, accent_color, last_seen_at)
  on public.profiles to authenticated;

-- Таблицы, изменяемые только через RPC
revoke insert, update, delete on public.servers, public.server_members, public.server_bans,
  public.channel_allowed_members, public.invites, public.dm_conversations,
  public.friendships, public.blocks from authenticated;
revoke update, delete on public.messages from authenticated;
revoke update on public.message_reactions from authenticated;


-- >>> 20261103000004_storage.sql
-- =====================================================================
-- Realism Voice — 0004: Storage buckets и политики
--   avatars       — публичное чтение; запись только в папку <user_id>/
--   server-icons  — публичное чтение; запись только admin+ в папку <server_id>/
--   attachments   — ПРИВАТНЫЙ; пути:
--                     channels/<channel_id>/<user_id>/<file>
--                     dms/<dm_id>/<user_id>/<file>
--                   чтение — только тем, кто видит канал/переписку
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars', 'avatars', true, 5242880,
   array['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  ('server-icons', 'server-icons', true, 5242880,
   array['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  ('attachments', 'attachments', false, 26214400, null)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------- avatars ----------
drop policy if exists rv_avatars_select on storage.objects;
create policy rv_avatars_select on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars');

drop policy if exists rv_avatars_insert on storage.objects;
create policy rv_avatars_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists rv_avatars_update on storage.objects;
create policy rv_avatars_update on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists rv_avatars_delete on storage.objects;
create policy rv_avatars_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------- server-icons ----------
drop policy if exists rv_icons_select on storage.objects;
create policy rv_icons_select on storage.objects
  for select to authenticated
  using (bucket_id = 'server-icons');

drop policy if exists rv_icons_insert on storage.objects;
create policy rv_icons_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'server-icons'
              and public.has_server_role(public.try_uuid((storage.foldername(name))[1]), 'admin'));

drop policy if exists rv_icons_update on storage.objects;
create policy rv_icons_update on storage.objects
  for update to authenticated
  using (bucket_id = 'server-icons'
         and public.has_server_role(public.try_uuid((storage.foldername(name))[1]), 'admin'))
  with check (bucket_id = 'server-icons'
              and public.has_server_role(public.try_uuid((storage.foldername(name))[1]), 'admin'));

drop policy if exists rv_icons_delete on storage.objects;
create policy rv_icons_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'server-icons'
         and public.has_server_role(public.try_uuid((storage.foldername(name))[1]), 'admin'));

-- ---------- attachments ----------
drop policy if exists rv_attachments_select on storage.objects;
create policy rv_attachments_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'attachments' and (
      ((storage.foldername(name))[1] = 'channels'
        and public.can_view_channel(public.try_uuid((storage.foldername(name))[2])))
      or ((storage.foldername(name))[1] = 'dms'
        and public.is_dm_participant(public.try_uuid((storage.foldername(name))[2])))
    )
  );

drop policy if exists rv_attachments_insert on storage.objects;
create policy rv_attachments_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[3] = (select auth.uid())::text
    and (
      ((storage.foldername(name))[1] = 'channels'
        and public.can_send_channel(public.try_uuid((storage.foldername(name))[2])))
      or ((storage.foldername(name))[1] = 'dms'
        and public.can_send_dm(public.try_uuid((storage.foldername(name))[2])))
    )
  );

drop policy if exists rv_attachments_delete on storage.objects;
create policy rv_attachments_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'attachments' and (
      (storage.foldername(name))[3] = (select auth.uid())::text
      or ((storage.foldername(name))[1] = 'channels'
        and public.has_server_role(
              public.channel_server(public.try_uuid((storage.foldername(name))[2])), 'moderator'))
    )
  );


-- >>> 20261103000005_realtime.sql
-- =====================================================================
-- Realism Voice — 0005: Realtime
--   * Postgres Changes для таблиц (RLS применяется к каждому подписчику)
--   * Realtime Authorization для приватных broadcast/presence каналов
-- =====================================================================

do $$
declare
  v_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach v_table in array array[
    'messages', 'channels', 'categories', 'servers', 'server_members',
    'friendships', 'dm_conversations', 'profiles', 'blocks'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end $$;

-- Приватные каналы: broadcast (набор текста) и presence (онлайн, голос)
drop policy if exists rv_realtime_select on realtime.messages;
create policy rv_realtime_select on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.realtime_topic_allowed((select realtime.topic()))
  );

drop policy if exists rv_realtime_insert on realtime.messages;
create policy rv_realtime_insert on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.realtime_topic_allowed((select realtime.topic()))
  );


-- >>> 20261104000001_user_badges.sql
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


-- >>> 20261104000002_profile_banners.sql
-- =====================================================================
-- Realism Voice — 0007: баннеры профилей
--   profiles.banner_path — путь к файлу; пользователь меняет только свой профиль,
--                          ограничение не даёт указать файл из чужой папки
--   profile-banners      — публичное чтение (как у аватаров); запись только
--                          одного файла вида <user_id>/<имя>.<png|jpg|jpeg|webp>
-- Скрипт идемпотентен и ничего не удаляет: повторный запуск безопасен.
-- =====================================================================

alter table public.profiles
  add column if not exists banner_path text;

alter table public.profiles
  drop constraint if exists profiles_banner_path_check;
alter table public.profiles
  add constraint profiles_banner_path_check check (
    banner_path is null
    or (char_length(banner_path) <= 300
        and banner_path ~ ('^' || id::text || '/[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$'))
  );

grant update (banner_path) on public.profiles to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('profile-banners', 'profile-banners', true, 5242880,
   array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists rv_banners_select on storage.objects;
create policy rv_banners_select on storage.objects
  for select to authenticated
  using (bucket_id = 'profile-banners');

drop policy if exists rv_banners_insert on storage.objects;
create policy rv_banners_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'profile-banners'
    and name ~ ('^' || (select auth.uid())::text || '/[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$')
  );

drop policy if exists rv_banners_update on storage.objects;
create policy rv_banners_update on storage.objects
  for update to authenticated
  using (bucket_id = 'profile-banners' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (
    bucket_id = 'profile-banners'
    and name ~ ('^' || (select auth.uid())::text || '/[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$')
  );

drop policy if exists rv_banners_delete on storage.objects;
create policy rv_banners_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'profile-banners' and (storage.foldername(name))[1] = (select auth.uid())::text);

notify pgrst, 'reload schema';

-- Результат в SQL Editor: одна строка; ожидается public=true, file_size_limit=5242880,
-- banner_path_exists=true, path_check_exists=true, storage_policies=4
select b.id, b.public, b.file_size_limit, b.allowed_mime_types,
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'profiles' and column_name = 'banner_path') as banner_path_exists,
       exists (select 1 from pg_constraint where conname = 'profiles_banner_path_check') as path_check_exists,
       (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'rv_banners_%') as storage_policies
from storage.buckets b
where b.id = 'profile-banners';


-- >>> 20261104000003_tester_badge.sql
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


-- >>> 20261107000001_attachments_v2.sql
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
