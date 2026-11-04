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
