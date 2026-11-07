import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

// Обновление существующей базы: все миграции ДО 0009, реальные данные (серверы, сообщения со старыми
// вложениями, личные переписки), затем миграция 0009 (дважды). Проверяется, что данные не изменились,
// доступ остался прежним, а старые и новые клиенты работают.
// Запуск: node scripts/test-sql-upgrade.mjs
const migDir = path.resolve('supabase/migrations');
const TARGET = '20261107000001_attachments_v2.sql';
const db = new PGlite();

await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create schema storage; create schema realtime; create schema extensions;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth, storage, realtime, public to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz default now());
create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare _parts text[]; begin select string_to_array(name, '/') into _parts; return _parts[1:array_length(_parts,1)-1]; end $$;
alter table storage.objects enable row level security;
grant all on storage.objects to authenticated;
create table realtime.messages (id bigserial primary key, topic text, extension text, payload jsonb);
create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
alter table realtime.messages enable row level security;
grant all on realtime.messages to authenticated; grant usage on sequence realtime.messages_id_seq to authenticated;
grant execute on function realtime.topic() to authenticated;
create publication supabase_realtime;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
`);

const files = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
for (const f of files.filter((f) => f < TARGET)) await db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
console.log(`applied ${files.filter((f) => f < TARGET).length} migrations before ${TARGET}`);

let failures = 0;
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
const C = '00000000-0000-4000-8000-0000000000c1';
async function as(uid, sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role ${uid ? 'authenticated' : 'anon'};`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
async function expectOk(name, fn) {
  try { const r = await fn(); console.log('  pass', name); return r; } catch (e) { failures++; console.log('  FAIL', name, '->', e.message); }
}
async function expectErr(name, fn) {
  try { await fn(); failures++; console.log('  FAIL (no error)', name); } catch (e) { console.log('  pass', name, '->', e.message.slice(0, 80)); }
}
function eq(name, a, b) { if (JSON.stringify(a) === JSON.stringify(b)) console.log('  pass', name); else { failures++; console.log('  FAIL', name, JSON.stringify(a), '!=', JSON.stringify(b)); } }

// ---------- «рабочие» данные версии 1.0.5 ----------
await db.exec(`insert into auth.users values
 ('${A}','a@x','{"username":"anna","display_name":"Anna"}'),
 ('${B}','b@x','{"username":"boris","display_name":"Boris"}'),
 ('${C}','c@x','{"username":"chuzhoy","display_name":"Stranger"}')`);
// администратор мог вручную ограничить типы файлов в панели — миграция должна это исправить
await db.exec(`update storage.buckets set allowed_mime_types = array['image/png','image/jpeg'] where id = 'attachments'`);
const srv = (await as(A, `select public.create_server('Рабочий сервер') id`)).rows[0].id;
const text = (await as(A, `select id from public.channels where server_id=$1 and type='text'`, [srv])).rows[0].id;
const code = (await as(A, `select public.create_invite($1, 5, 24) c`, [srv])).rows[0].c;
await as(B, 'select public.join_server($1)', [code]);
await as(A, `select public.send_friend_request('boris')`);
await as(B, `select public.send_friend_request('anna')`);
const dm = (await as(A, 'select public.open_dm($1) id', [B])).rows[0].id;
// старые объекты (настоящие метаданные Storage) и сообщения 1.0.5 (вложения без kind, width: null)
const oldImg = `channels/${text}/${A}/11111111-1111-4111-8111-111111111111-photo.png`;
const oldDm = `dms/${dm}/${B}/22222222-2222-4222-8222-222222222222-doc.pdf`;
const oldNoMeta = `channels/${text}/${B}/33333333-3333-4333-8333-333333333333-old.bin`;
await as(A, `insert into storage.objects (bucket_id, name, metadata) values ('attachments', $1, '{"size": 120000, "mimetype": "image/png", "eTag": "x"}')`, [oldImg]);
await as(B, `insert into storage.objects (bucket_id, name, metadata) values ('attachments', $1, '{"size": 300000, "mimetype": "application/pdf"}')`, [oldDm]);
await as(B, `insert into storage.objects (bucket_id, name) values ('attachments', $1)`, [oldNoMeta]);
const m1 = (await as(A, `insert into public.messages (channel_id, content, attachments) values ($1, 'фото', $2) returning id, attachments`, [text, JSON.stringify([{ path: oldImg, name: 'photo.png', size: 120000, mime: 'image/png', width: 800, height: 600 }])])).rows[0];
const m2 = (await as(B, `insert into public.messages (dm_id, content, attachments) values ($1, 'документ', $2) returning id, attachments`, [dm, JSON.stringify([{ path: oldDm, name: 'doc.pdf', size: 300000, mime: 'application/pdf' }])])).rows[0];
const m3 = (await as(B, `insert into public.messages (channel_id, content, attachments) values ($1, '', $2) returning id, attachments`, [text, JSON.stringify([{ path: oldNoMeta, name: 'old.bin', size: 77, mime: 'application/octet-stream' }])])).rows[0];
const snapshot = async () => ({
  messages: (await db.query('select id, content, attachments, author_id, channel_id, dm_id, created_at from public.messages order by id')).rows,
  servers: (await db.query('select id, name, owner_id from public.servers order by id')).rows,
  members: (await db.query('select server_id, user_id, role from public.server_members order by server_id, user_id')).rows,
  profiles: (await db.query('select id, username, display_name, badge from public.profiles order by id')).rows,
  objects: (await db.query(`select bucket_id, name, metadata from storage.objects order by name`)).rows,
  dms: (await db.query('select id, user_low, user_high from public.dm_conversations order by id')).rows,
});
const before = await snapshot();

// ---------- миграция 0009 (дважды — идемпотентность) ----------
const sql = fs.readFileSync(path.join(migDir, TARGET), 'utf8');
await expectOk('migration applies on populated database', () => db.exec(sql));
await expectOk('migration re-applies (idempotent)', () => db.exec(sql));
const after = await snapshot();
eq('messages unchanged', after.messages, before.messages);
eq('servers unchanged', after.servers, before.servers);
eq('members unchanged', after.members, before.members);
eq('profiles unchanged', after.profiles, before.profiles);
eq('storage objects unchanged', after.objects, before.objects);
eq('dm conversations unchanged', after.dms, before.dms);
const bucket = (await db.query(`select public, file_size_limit, allowed_mime_types from storage.buckets where id='attachments'`)).rows[0];
eq('attachments bucket: private, 50 MB, any file type', [bucket.public, Number(bucket.file_size_limit), bucket.allowed_mime_types], [false, 52428800, null]);
eq('other buckets untouched', (await db.query(`select id, file_size_limit from storage.buckets where id <> 'attachments' order by id`)).rows.map((r) => [r.id, Number(r.file_size_limit)]),
  [['avatars', 5242880], ['profile-banners', 5242880], ['server-icons', 5242880]]);

// ---------- старые данные читаются как раньше ----------
eq('member reads old channel attachment object', (await as(B, `select count(*)::int n from storage.objects where name=$1`, [oldImg])).rows[0].n, 1);
eq('DM participant reads old DM attachment', (await as(A, `select count(*)::int n from storage.objects where name=$1`, [oldDm])).rows[0].n, 1);
eq('stranger reads nothing', (await as(C, `select count(*)::int n from storage.objects where bucket_id='attachments'`)).rows[0].n, 0);
eq('stranger cannot read old messages', (await as(C, 'select count(*)::int n from public.messages')).rows[0].n, 0);
eq('old message attachments intact for members', (await as(B, 'select attachments from public.messages where id=$1', [m1.id])).rows[0].attachments, m1.attachments);
await expectOk('author edits old message with attachment', () => as(A, `select public.edit_message($1, 'фото (изм.)')`, [m1.id]));
eq('attachments survive edit', (await db.query('select attachments from public.messages where id=$1', [m1.id])).rows[0].attachments, m1.attachments);
await expectOk('download grant works for old attachment', () => as(B, 'select public.request_attachment_download($1)', [oldImg]));
eq('old object without metadata counts as 0 bytes, no error', Number((await as(B, 'select public.request_attachment_download($1) s', [oldNoMeta])).rows[0].s), 0);
eq('old message stays attached (not stale)', (await as(A, 'select path from public.my_stale_uploads()')).rows.length, 0);

// ---------- старый клиент 1.0.5 после миграции (флаги выключены) ----------
const legacyPath = `channels/${text}/${B}/44444444-4444-4444-8444-444444444444-video.mkv`;
await expectOk('old client: upload without reservation', () => as(B, `insert into storage.objects (bucket_id, name, metadata) values ('attachments', $1, '{"size": 2000000, "mimetype": "video/x-matroska"}')`, [legacyPath]));
const legacyMsg = await expectOk('old client: message in old format', () => as(B, `insert into public.messages (channel_id, content, attachments) values ($1, '', $2) returning attachments`, [text, JSON.stringify([{ path: legacyPath, name: 'video.mkv', size: 2000000, mime: 'video/x-matroska', width: null, height: null }])]));
eq('old client sees fields it knows', Object.keys(legacyMsg.rows[0].attachments[0]).filter((k) => ['path', 'name', 'size', 'mime'].includes(k)).sort(), ['mime', 'name', 'path', 'size']);
await expectOk('author deletes own old message', () => as(B, 'select public.delete_message($1)', [m3.id]));
eq('file of deleted message is now unattached', (await as(B, 'select path from public.my_stale_uploads()')).rows.length, 0); // ещё не прошло 2 часа
await expectOk('author removes file of deleted message', () => as(B, `delete from storage.objects where name=$1`, [oldNoMeta]));

// ---------- новый клиент 1.1 ----------
const res = (await as(A, `select path from public.reserve_attachment('dm', $1, 'архив.zip', 5000)`, [dm])).rows[0];
await expectOk('new client: reserved upload', () => as(A, `insert into storage.objects (bucket_id, name, metadata) values ('attachments', $1, '{"size": 5000}')`, [res.path]));
await expectOk('new client: folder message', () => as(A, `insert into public.messages (dm_id, content, attachments) values ($1, '', $2)`, [dm, JSON.stringify([{ path: res.path, name: 'Проект', size: 5000, kind: 'folder', folder: { files: 3, dirs: 1, bytes: 9000 } }])]));

// ---------- включение обязательного режима ----------
await db.exec('update public.app_limits set enforce_reservations = true, enforce_download_grants = true');
await expectErr('enforced: old client upload rejected', () => as(B, `insert into storage.objects (bucket_id, name, metadata) values ('attachments', $1, '{"size": 10}')`, [`channels/${text}/${B}/55555555-5555-4555-8555-555555555555-x.bin`]));
eq('enforced: old client cannot sign URLs without grant', (await as(B, `select count(*)::int n from storage.objects where name=$1`, [oldDm])).rows[0].n, 0);
eq('enforced: messages still readable', (await as(B, 'select count(*)::int n from public.messages where deleted_at is null')).rows[0].n >= 3, true);
await expectOk('enforced: new client downloads with grant', () => as(B, 'select public.request_attachment_download($1)', [oldDm]));
eq('enforced: URL allowed after grant', (await as(B, `select count(*)::int n from storage.objects where name=$1`, [oldDm])).rows[0].n, 1);
await expectOk('enforced: rollback flags restores old behavior', () => db.exec('update public.app_limits set enforce_reservations = false, enforce_download_grants = false'));
eq('after rollback old client reads again', (await as(A, `select count(*)::int n from storage.objects where name=$1`, [oldImg])).rows[0].n, 1);

console.log(failures ? `\n${failures} FAILURES` : '\nUPGRADE CHECKS PASSED');
process.exit(failures ? 1 : 0);
