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
