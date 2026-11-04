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
