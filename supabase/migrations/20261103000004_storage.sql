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
