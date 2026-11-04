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
