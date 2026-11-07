import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

// Проверка миграций и RLS на встроенном PostgreSQL (PGlite) с заглушками схем Supabase.
// Запуск: npm run test:sql
const migDir = process.argv[2] ?? path.resolve('supabase/migrations');
const db = new PGlite();

const stubs = `
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
`;
await db.exec(stubs);

for (const f of fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
  try { await db.exec(sql); console.log('OK  ', f); }
  catch (e) { console.log('FAIL', f, e.message); process.exit(1); }
}
// re-run for idempotency
for (const f of fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
  try { await db.exec(fs.readFileSync(path.join(migDir, f), 'utf8')); } catch (e) { console.log('RERUN FAIL', f, e.message); process.exit(1); }
}
console.log('idempotent re-run OK');

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
await db.exec(`insert into auth.users values
 ('${A}','a@x','{"username":"alice","display_name":"Alice"}'),
 ('${B}','b@x','{"username":"bob","display_name":"Bob"}'),
 ('${C}','c@x','{"username":"alice"}')`);

let failures = 0;
async function as(uid, sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role ${uid ? 'authenticated' : 'anon'};`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
async function expectOk(name, fn) {
  try { const r = await fn(); console.log('  pass', name); return r; }
  catch (e) { failures++; console.log('  FAIL', name, '->', e.message); }
}
async function expectErr(name, fn) {
  try { await fn(); failures++; console.log('  FAIL (no error)', name); }
  catch (e) { console.log('  pass', name, '->', e.message.slice(0, 80)); }
}
function eq(name, a, b) { if (JSON.stringify(a) === JSON.stringify(b)) console.log('  pass', name); else { failures++; console.log('  FAIL', name, a, '!=', b); } }

const profiles = (await db.query('select id, username, display_name from public.profiles order by username')).rows;
console.log(profiles);

const srv = (await as(A, `select public.create_server('Test server') as id`)).rows[0].id;
const chans = (await as(A, `select id, name, type from public.channels where server_id = $1 order by type`, [srv])).rows;
eq('default channels', chans.map((c) => c.type), ['text', 'voice']);
const text = chans[0].id, voice = chans[1].id;

eq('B cannot see server', (await as(B, 'select * from public.servers')).rows.length, 0);
eq('B cannot see channels', (await as(B, 'select * from public.channels')).rows.length, 0);
await expectErr('B cannot insert channel', () => as(B, `insert into public.channels (server_id, name) values ($1, 'hack')`, [srv]));
await expectErr('B cannot insert member', () => as(B, `insert into public.server_members (server_id, user_id, role) values ($1, $2, 'admin')`, [srv, B]));
await expectErr('anon cannot read profiles', () => as(null, 'select * from public.profiles'));
eq('anon username_available', (await as(null, `select public.username_available('newname') as v`)).rows[0].v, true);

const code = (await as(A, `select public.create_invite($1, 5, 24) as c`, [srv])).rows[0].c;
eq('preview invite', (await as(B, `select name, already_member from public.preview_invite($1)`, [code])).rows[0], { name: 'Test server', already_member: false });
await as(B, `select public.join_server($1)`, [code]);
eq('B sees server after join', (await as(B, 'select count(*)::int n from public.servers')).rows[0].n, 1);
await expectErr('B cannot self-promote', () => as(B, `select public.set_member_role($1, $2, 'admin')`, [srv, B]));
await expectErr('B cannot update role directly', () => as(B, `update public.server_members set role='admin' where user_id=$1`, [B]));
eq('B still member', (await db.query(`select role from public.server_members where user_id=$1`, [B])).rows[0].role, 'member');
await expectErr('B cannot kick A', () => as(B, `select public.kick_member($1, $2)`, [srv, A]));
await expectErr('B cannot update server', () => as(B, `select public.update_server($1, 'x', '', null, true)`, [srv]));

const m1 = await expectOk('B sends message', () => as(B, `insert into public.messages (channel_id, content) values ($1, 'hi @alice') returning id, mentions, author_id`, [text]));
eq('mention parsed', m1.rows[0].mentions, [A]);
const msgId = m1.rows[0].id;
await expectErr('B cannot forge author', () => as(B, `insert into public.messages (channel_id, author_id, content) values ($1, $2, 'x') returning author_id`, [text, A]).then((r) => { if (r.rows[0].author_id !== A) throw new Error('author normalized to self'); }));
eq('C cannot read channel messages', (await as(C, 'select * from public.messages')).rows.length, 0);
await expectErr('C cannot post to channel', () => as(C, `insert into public.messages (channel_id, content) values ($1, 'x')`, [text]));
await expectErr('A cannot edit B message', () => as(A, `select public.edit_message($1, 'hacked')`, [msgId]));
await expectErr('A cannot UPDATE directly', () => as(A, `update public.messages set content='hacked' where id=$1`, [msgId]));
await expectOk('B edits own message', () => as(B, `select public.edit_message($1, 'edited')`, [msgId]));
await expectOk('B reacts', () => as(B, `insert into public.message_reactions (message_id, emoji) values ($1, '👍')`, [msgId]));
await expectOk('A reacts', () => as(A, `insert into public.message_reactions (message_id, emoji) values ($1, '👍')`, [msgId]));
eq('reactions aggregated', (await db.query('select reactions from public.messages where id=$1', [msgId])).rows[0].reactions, { '👍': [B, A] });
await expectErr('C cannot react', () => as(C, `insert into public.message_reactions (message_id, emoji) values ($1, '🔥')`, [msgId]));

eq('unread for A', (await as(A, 'select unread, mentions from public.get_unread_counts()')).rows, [{ unread: 2, mentions: 0 }]);
await as(B, `insert into public.messages (channel_id, content) values ($1, 'ping @alice')`, [text]);
eq('mention counted', (await as(A, 'select unread, mentions from public.get_unread_counts()')).rows, [{ unread: 3, mentions: 1 }]);
await as(A, 'select public.mark_read($1)', [text]);
eq('unread after read', (await as(A, 'select * from public.get_unread_counts()')).rows.length, 0);

// moderator (A owner) deletes B message
await expectOk('owner deletes B message', () => as(A, 'select public.delete_message($1)', [msgId]));
eq('soft deleted', (await db.query('select content, deleted_at is not null d from public.messages where id=$1', [msgId])).rows[0], { content: '', d: true });

// private channel
const priv = (await as(A, `insert into public.channels (server_id, name, is_private) values ($1, 'secret', true) returning id`, [srv])).rows[0].id;
eq('B cannot see private channel', (await as(B, 'select * from public.channels where id=$1', [priv])).rows.length, 0);
await expectErr('B cannot post private', () => as(B, `insert into public.messages (channel_id, content) values ($1, 'x')`, [priv]));
eq('B voice_access private none', (await as(B, `select * from public.voice_access($1)`, [priv])).rows.length, 0);
eq('B voice_access public', (await as(B, `select can_join, can_speak from public.voice_access($1)`, [voice])).rows[0], { can_join: true, can_speak: true });
await as(A, 'select public.set_channel_allowed_members($1, $2)', [priv, [B]]);
eq('B sees private after allow', (await as(B, 'select count(*)::int n from public.channels where id=$1', [priv])).rows[0].n, 1);

// promote B to moderator, B cannot promote self to admin
await expectOk('A promotes B to moderator', () => as(A, `select public.set_member_role($1, $2, 'moderator')`, [srv, B]));
await expectErr('moderator cannot grant admin', () => as(B, `select public.set_member_role($1, $2, 'admin')`, [srv, B]));

// rate limit
await expectErr('rate limit triggers', async () => { for (let i = 0; i < 12; i++) await as(B, `insert into public.messages (channel_id, content) values ($1, 'spam ' || $2)`, [text, String(i)]); });

// friends & DMs
eq('friend request', (await as(A, `select public.send_friend_request('bob') r`)).rows[0].r, 'sent');
eq('reverse accepts', (await as(B, `select public.send_friend_request('alice') r`)).rows[0].r, 'accepted');
const dm = (await as(A, `select public.open_dm($1) id`, [B])).rows[0].id;
eq('dm idempotent', (await as(B, `select public.open_dm($1) id`, [A])).rows[0].id, dm);
await expectOk('A sends DM', () => as(A, `insert into public.messages (dm_id, content) values ($1, 'private')`, [dm]));
eq('C cannot read DM', (await as(C, 'select * from public.messages where dm_id=$1', [dm])).rows.length, 0);
eq('C cannot see dm conversation', (await as(C, 'select * from public.dm_conversations')).rows.length, 0);
await expectErr('C cannot post DM', () => as(C, `insert into public.messages (dm_id, content) values ($1, 'x')`, [dm]));
eq('B unread DM', (await as(B, 'select unread from public.get_unread_counts() where server_id is null')).rows, [{ unread: 1 }]);
await as(B, 'select public.block_user($1)', [A]);
await expectErr('blocked cannot DM', () => as(A, `insert into public.messages (dm_id, content) values ($1, 'x')`, [dm]));
eq('friendship removed on block', (await db.query('select count(*)::int n from public.friendships')).rows[0].n, 0);
await expectErr('blocked cannot friend', () => as(A, `select public.send_friend_request('bob')`));

// storage
await expectOk('B uploads attachment to channel folder', () => as(B, `insert into storage.objects (bucket_id, name) values ('attachments', $1)`, [`channels/${text}/${B}/f.png`]));
await expectErr('B cannot upload into A folder', () => as(B, `insert into storage.objects (bucket_id, name) values ('attachments', $1)`, [`channels/${text}/${A}/f.png`]));
await expectErr('C cannot upload to channel', () => as(C, `insert into storage.objects (bucket_id, name) values ('attachments', $1)`, [`channels/${text}/${C}/f.png`]));
eq('C cannot read attachment', (await as(C, `select * from storage.objects where bucket_id='attachments'`)).rows.length, 0);
eq('A can read attachment', (await as(A, `select count(*)::int n from storage.objects where bucket_id='attachments'`)).rows[0].n, 1);
await expectErr('B cannot upload avatar for A', () => as(B, `insert into storage.objects (bucket_id, name) values ('avatars', $1)`, [`${A}/a.png`]));
await expectErr('B (mod) cannot upload server icon', () => as(B, `insert into storage.objects (bucket_id, name) values ('server-icons', $1)`, [`${srv}/i.png`]));
await expectOk('A uploads server icon', () => as(A, `insert into storage.objects (bucket_id, name) values ('server-icons', $1)`, [`${srv}/i.png`]));
await expectErr('A cannot attach foreign path', () => as(A, `insert into public.messages (channel_id, content, attachments) values ($1, 'x', $2)`, [text, JSON.stringify([{ path: `channels/${priv}/${A}/x`, name: 'x', size: 1 }])]));
await expectErr('A cannot attach path that was never uploaded', () => as(A, `insert into public.messages (channel_id, content, attachments) values ($1, '', $2)`, [text, JSON.stringify([{ path: `channels/${text}/${A}/x.png`, name: 'x.png', size: 10, mime: 'image/png', width: 5 }])]));
await expectOk('A uploads x.png (legacy path, reservations not enforced)', () => as(A, `insert into storage.objects (bucket_id, name, metadata) values ('attachments', $1, $2)`, [`channels/${text}/${A}/x.png`, JSON.stringify({ size: 10, mimetype: 'image/png' })]));
await expectOk('A can attach own path', () => as(A, `insert into public.messages (channel_id, content, attachments) values ($1, '', $2)`, [text, JSON.stringify([{ path: `channels/${text}/${A}/x.png`, name: 'x.png', size: 10, mime: 'image/png', width: 5 }])]));

// ---------- вложения v2: лимиты бесплатного тарифа, резерв, квоты, учёт трафика ----------
const bucketLimit = async (id) => Number((await db.query('select file_size_limit from storage.buckets where id=$1', [id])).rows[0].file_size_limit);
eq('attachments bucket limit is 50 MB (Supabase Free maximum)', await bucketLimit('attachments'), 50 * 1024 * 1024);
eq('avatars bucket limit unchanged (5 MB)', await bucketLimit('avatars'), 5 * 1024 * 1024);
eq('server-icons bucket limit unchanged (5 MB)', await bucketLimit('server-icons'), 5 * 1024 * 1024);
eq('attachments bucket stays private', (await db.query(`select public from storage.buckets where id='attachments'`)).rows[0].public, false);
eq('limits readable by users', Number((await as(B, 'select attachment_max_bytes from public.app_limits')).rows[0].attachment_max_bytes), 50 * 1024 * 1024);
await as(B, 'update public.app_limits set attachments_total_bytes = 999999999999').catch(() => undefined);
eq('users cannot change limits', Number((await db.query('select attachments_total_bytes from public.app_limits')).rows[0].attachments_total_bytes), 734003200);
const reserve = (uid, kind, scope, name, size) => as(uid, 'select path, max_bytes from public.reserve_attachment($1, $2, $3, $4)', [kind, scope, name, size]);
const r1 = (await reserve(A, 'channel', text, 'Отчёт ../../evil 2026.pdf', 1000)).rows[0];
eq('reserved path is inside channel/user folder', r1.path.startsWith(`channels/${text}/${A}/`) && r1.path.endsWith('.pdf'), true);
eq('reserved path has no traversal or nesting', !r1.path.includes('..') && r1.path.split('/').length === 4, true);
eq('reserve reports max size', Number(r1.max_bytes), 50 * 1024 * 1024);
await expectErr('reserve over 50 MB rejected', () => reserve(A, 'channel', text, 'big.iso', 50 * 1024 * 1024 + 1));
await expectErr('reserve empty file rejected', () => reserve(A, 'channel', text, 'empty.txt', 0));
await expectErr('C cannot reserve in foreign channel', () => reserve(C, 'channel', text, 'x.zip', 10));
await expectErr('anon cannot reserve', () => reserve(null, 'channel', text, 'x.zip', 10));
await expectErr('bad scope kind rejected', () => reserve(A, 'server', text, 'x.zip', 10));
await expectErr('reserve in private channel without access rejected', () => reserve(C, 'channel', priv, 'x.zip', 10));
eq('reservation visible only to owner', (await as(C, 'select count(*)::int n from public.attachment_uploads')).rows[0].n, 0);
await expectErr('client cannot insert reservation directly', () => as(C, `insert into public.attachment_uploads (path, user_id, scope_kind, scope_id, declared_size) values ('dms/x/y/z', $1, 'dm', $2, 1)`, [C, text]));
await expectOk('A uploads reserved file', () => as(A, `insert into storage.objects (bucket_id, name, metadata) values ('attachments', $1, $2)`, [r1.path, JSON.stringify({ size: 1000, mimetype: 'application/pdf' })]));
const sent = (await as(A, `insert into public.messages (channel_id, content, attachments) values ($1, '', $2) returning attachments`, [text, JSON.stringify([{ path: r1.path, name: 'Отчёт.pdf', size: 1, mime: 'text/html', kind: 'file' }])])).rows[0].attachments[0];
eq('size taken from storage, not from client', sent.size, 1000);
eq('mime taken from storage, not from client', sent.mime, 'application/pdf');
eq('reservation marked consumed after message', (await db.query('select consumed_at is not null c from public.attachment_uploads where path=$1', [r1.path])).rows[0].c, true);
await expectErr('nested attachment path rejected', () => as(A, `insert into public.messages (channel_id, content, attachments) values ($1, '', $2)`, [text, JSON.stringify([{ path: `channels/${text}/${A}/sub/x`, name: 'x', size: 1 }])]));
await expectErr('nested upload path rejected by storage policy', () => as(A, `insert into storage.objects (bucket_id, name) values ('attachments', $1)`, [`channels/${text}/${A}/sub/x`]));
const rf = (await reserve(A, 'channel', text, 'Проект.zip', 2000)).rows[0];
await as(A, `insert into storage.objects (bucket_id, name, metadata) values ('attachments', $1, $2)`, [rf.path, JSON.stringify({ size: 2000, mimetype: 'application/octet-stream' })]);
const folderAtt = (await as(A, `insert into public.messages (channel_id, content, attachments) values ($1, '', $2) returning attachments`, [text, JSON.stringify([{ path: rf.path, name: 'Проект', size: 2000, kind: 'folder', folder: { files: 12, dirs: 3, bytes: 99999, evil: 'x' } }])])).rows[0].attachments[0];
eq('folder attachment keeps sanitized metadata', [folderAtt.kind, folderAtt.mime, folderAtt.folder.files, folderAtt.folder.dirs, folderAtt.folder.bytes, 'evil' in folderAtt.folder], ['folder', 'application/zip', 12, 3, 99999, false]);
// квоты
await db.exec('update public.app_limits set user_storage_bytes = 5000');
await expectOk('reserve within personal quota', () => reserve(A, 'channel', text, 'a.bin', 1500));
await expectErr('personal storage quota enforced (used + pending)', () => reserve(A, 'channel', text, 'b.bin', 1600));
await db.exec('update public.app_limits set user_storage_bytes = 157286400, attachments_total_bytes = 4000');
await expectErr('project storage quota enforced for everyone', () => reserve(B, 'channel', text, 'c.bin', 600));
await db.exec('update public.app_limits set attachments_total_bytes = 734003200, user_daily_upload_bytes = 6000');
await expectErr('daily upload quota enforced', () => reserve(A, 'channel', text, 'd.bin', 2000));
await db.exec('update public.app_limits set user_daily_upload_bytes = 262144000');
// обязательный резерв
await db.exec('update public.app_limits set enforce_reservations = true');
await expectErr('upload without reservation rejected when enforced', () => as(B, `insert into storage.objects (bucket_id, name) values ('attachments', $1)`, [`channels/${text}/${B}/noreserve.bin`]));
const rb = (await reserve(B, 'channel', text, 'ok.bin', 10)).rows[0];
await expectErr('reservation of another user cannot be used', () => as(A, `insert into storage.objects (bucket_id, name) values ('attachments', $1)`, [rb.path]));
await expectOk('upload with own reservation allowed when enforced', () => as(B, `insert into storage.objects (bucket_id, name, metadata) values ('attachments', $1, '{"size":10}')`, [rb.path]));
await db.exec('update public.app_limits set enforce_reservations = false');
// учёт трафика скачиваний
const G = '00000000-0000-4000-8000-000000000001';
await db.exec(`insert into auth.users values ('${G}','g@x','{"username":"gena","display_name":"Gena"}')`);
await as(G, 'select public.join_server($1)', [code]);
await expectErr('C cannot request foreign attachment', () => as(C, 'select public.request_attachment_download($1)', [r1.path]));
await expectErr('download of missing file rejected', () => as(G, 'select public.request_attachment_download($1)', [`channels/${text}/${A}/missing.bin`]));
await expectErr('download path traversal rejected', () => as(G, 'select public.request_attachment_download($1)', [`channels/${text}/../${A}/x`]));
await db.exec('update public.app_limits set enforce_download_grants = true, user_month_download_bytes = 2500');
eq('member cannot sign attachment URL without grant', (await as(G, `select count(*)::int n from storage.objects where name=$1`, [r1.path])).rows[0].n, 0);
eq('grant returns real size', Number((await as(G, 'select public.request_attachment_download($1) s', [r1.path])).rows[0].s), 1000);
eq('member can sign URL after grant', (await as(G, `select count(*)::int n from storage.objects where name=$1`, [r1.path])).rows[0].n, 1);
await expectOk('repeat download within 15 min is not counted twice', () => as(G, 'select public.request_attachment_download($1)', [r1.path]));
eq('one download logged', (await db.query('select count(*)::int n from public.attachment_downloads where user_id=$1', [G])).rows[0].n, 1);
await expectErr('monthly personal download quota enforced', () => as(G, 'select public.request_attachment_download($1)', [rf.path]));
eq('uploader still sees own file for deletion', (await as(A, `select count(*)::int n from storage.objects where name=$1`, [rf.path])).rows[0].n, 1);
await db.exec('update public.app_limits set user_month_download_bytes = 1073741824, egress_month_bytes = 1500');
await expectErr('project monthly egress quota enforced', () => as(G, 'select public.request_attachment_download($1)', [rf.path]));
await db.exec('update public.app_limits set egress_month_bytes = 3758096384, enforce_download_grants = false');
eq('C still cannot see attachments', (await as(C, `select count(*)::int n from storage.objects where bucket_id='attachments'`)).rows[0].n, 0);
// брошенные загрузки
const orphan = `channels/${text}/${A}/orphan.bin`;
await db.exec(`insert into storage.objects (bucket_id, name, metadata, created_at) values ('attachments', '${orphan}', '{"size":5}', now() - interval '3 hours')`);
eq('stale upload listed for its owner', (await as(A, 'select path from public.my_stale_uploads()')).rows.map((r) => r.path).includes(orphan), true);
eq('attached files are not stale', (await as(A, 'select path from public.my_stale_uploads()')).rows.map((r) => r.path).includes(r1.path), false);
eq('stale uploads of others are hidden', (await as(G, 'select path from public.my_stale_uploads()')).rows.length, 0);
const usage = (await as(A, 'select public.attachment_usage() u')).rows[0].u;
eq('usage reports quotas', usage.max_file === 50 * 1024 * 1024 && usage.user_used >= 3000 && usage.user_limit === 157286400, true);
await expectErr('anon cannot read usage', () => as(null, 'select public.attachment_usage()'));

// realtime
await db.exec(`select set_config('realtime.topic', 'typing:${text}', false)`);
eq('C cannot read typing topic', (await as(C, `select public.realtime_topic_allowed('typing:${text}') v`)).rows[0].v, false);
eq('A can typing topic', (await as(A, `select public.realtime_topic_allowed('typing:${text}') v`)).rows[0].v, true);
eq('C dm topic denied', (await as(C, `select public.realtime_topic_allowed('dm:${dm}') v`)).rows[0].v, false);
eq('bad topic denied', (await as(A, `select public.realtime_topic_allowed('voice:not-a-uuid') v`)).rows[0].v, false);

// profile
await expectErr('B cannot edit A profile', async () => { const r = await as(B, `update public.profiles set display_name='x' where id=$1 returning id`, [A]); if (!r.rows.length) throw new Error('0 rows'); });
await expectErr('username format', () => as(B, `update public.profiles set username='Bad Name!' where id=$1`, [B]));
await expectErr('username unique', () => as(B, `update public.profiles set username='alice' where id=$1`, [B]));

// leave / owner
await expectErr('owner cannot leave', () => as(A, 'select public.leave_server($1)', [srv]));
await expectOk('B leaves', () => as(B, 'select public.leave_server($1)', [srv]));
eq('B no longer sees messages', (await as(B, 'select count(*)::int n from public.messages where channel_id is not null')).rows[0].n, 0);

// значок Owner
const D = '00000000-0000-4000-8000-00000000000d';
const E = '00000000-0000-4000-8000-00000000000e';
const badgeSql = fs.readFileSync(path.join(migDir, '20261104000001_user_badges.sql'), 'utf8');
await db.exec(`insert into auth.users values ('${D}','d@x','{"username":"realism","display_name":"Realism"}')`);
await db.exec(badgeSql);
const badgeOf = async (id) => (await db.query('select badge from public.profiles where id=$1', [id])).rows[0].badge;
eq('realism gets owner badge', await badgeOf(D), 'owner');
eq('others have no badge', await badgeOf(A), null);
await expectErr('user cannot grant self badge', () => as(A, `update public.profiles set badge='owner' where id=$1`, [A]));
await expectErr('owner cannot change badge via client', () => as(D, `update public.profiles set badge=null where id=$1`, [D]));
eq('badge visible to others', (await as(A, 'select badge from public.profiles where id=$1', [D])).rows[0].badge, 'owner');
await expectOk('owner can still edit own profile', () => as(D, `update public.profiles set username='realism_x', bio='hi' where id=$1`, [D]));
eq('badge survives rename', await badgeOf(D), 'owner');
await db.exec(`insert into auth.users values ('${E}','e@x','{"username":"realism"}')`);
await db.exec(badgeSql);
eq('new holder of username gets no badge on re-run', await badgeOf(E), null);
await expectErr('invalid badge value rejected', () => db.exec(`update public.profiles set badge='admin' where id='${A}'`));

// баннеры профилей
const bannerOf = async (id) => (await db.query('select banner_path from public.profiles where id=$1', [id])).rows[0].banner_path;
const uploadBanner = (uid, name) => as(uid, `insert into storage.objects (bucket_id, name) values ('profile-banners', $1)`, [name]);
const bucket = (await db.query(`select public, file_size_limit, allowed_mime_types from storage.buckets where id='profile-banners'`)).rows[0];
eq('banner bucket is public for reading', bucket.public, true);
eq('banner bucket limit is 5 MB', Number(bucket.file_size_limit), 5 * 1024 * 1024);
eq('banner bucket allows only png, jpeg, webp', [...bucket.allowed_mime_types].sort().join(), 'image/jpeg,image/png,image/webp');
await expectOk('A uploads own banner', () => uploadBanner(A, `${A}/1-abc.webp`));
await expectOk('A uploads png banner', () => uploadBanner(A, `${A}/2-abc.png`));
await expectOk('A uploads jpg banner', () => uploadBanner(A, `${A}/3-abc.jpg`));
await expectErr('B cannot upload into A banner folder', () => uploadBanner(B, `${A}/evil.webp`));
await expectErr('banner path traversal rejected', () => uploadBanner(A, `${A}/../${B}/evil.webp`));
await expectErr('nested banner path rejected', () => uploadBanner(A, `${A}/sub/evil.webp`));
await expectErr('banner in bucket root rejected', () => uploadBanner(A, 'evil.webp'));
await expectErr('svg banner rejected', () => uploadBanner(A, `${A}/evil.svg`));
await expectErr('html banner rejected', () => uploadBanner(A, `${A}/evil.html`));
await expectErr('double extension banner rejected', () => uploadBanner(A, `${A}/evil.webp.exe`));
await expectErr('avatar folder rules do not allow banner of another user', () => as(B, `insert into storage.objects (bucket_id, name) values ('avatars', $1)`, [`${A}/b.webp`]));
const bannerObjects = async (uid) => (await as(uid, `select name from storage.objects where bucket_id='profile-banners' order by name`)).rows.map((r) => r.name);
eq('others can see banner files', (await bannerObjects(B)).length, 3);
await as(B, `update storage.objects set name=$1 where bucket_id='profile-banners' and name=$2`, [`${B}/stolen.webp`, `${A}/1-abc.webp`]);
eq('B cannot move A banner', (await bannerObjects(A)).includes(`${A}/1-abc.webp`), true);
await as(B, `delete from storage.objects where bucket_id='profile-banners' and name like $1`, [`${A}/%`]);
eq('B cannot delete A banner', (await bannerObjects(A)).length, 3);
await expectErr('A cannot rename banner into B folder', () => as(A, `update storage.objects set name=$1 where bucket_id='profile-banners' and name=$2`, [`${B}/x.webp`, `${A}/2-abc.png`]));
await expectOk('A sets own banner_path', () => as(A, `update public.profiles set banner_path=$1 where id=$2`, [`${A}/1-abc.webp`, A]));
eq('banner_path saved', await bannerOf(A), `${A}/1-abc.webp`);
eq('others read banner_path', (await as(B, 'select banner_path from public.profiles where id=$1', [A])).rows[0].banner_path, `${A}/1-abc.webp`);
await as(B, `update public.profiles set banner_path=null where id=$1`, [A]);
eq('B cannot clear A banner_path', await bannerOf(A), `${A}/1-abc.webp`);
await as(B, `update public.profiles set banner_path=$1 where id=$2`, [`${A}/2-abc.png`, A]);
eq('B cannot change A banner_path', await bannerOf(A), `${A}/1-abc.webp`);
await expectErr('A cannot point banner_path at B file', () => as(A, `update public.profiles set banner_path=$1 where id=$2`, [`${B}/x.webp`, A]));
await expectErr('banner_path traversal rejected', () => as(A, `update public.profiles set banner_path=$1 where id=$2`, [`${A}/../x.webp`, A]));
await expectErr('banner_path URL rejected', () => as(A, `update public.profiles set banner_path=$1 where id=$2`, ['https://evil.example/x.webp', A]));
await expectErr('banner_path svg rejected', () => as(A, `update public.profiles set banner_path=$1 where id=$2`, [`${A}/x.svg`, A]));
await expectOk('A removes own banner_path', () => as(A, `update public.profiles set banner_path=null where id=$1`, [A]));
eq('banner_path removed', await bannerOf(A), null);
await expectOk('A deletes own banner file', () => as(A, `delete from storage.objects where bucket_id='profile-banners' and name=$1`, [`${A}/1-abc.webp`]));
eq('own banner file deleted', (await bannerObjects(A)).includes(`${A}/1-abc.webp`), false);
await expectErr('badge still not editable next to banner', () => as(A, `update public.profiles set badge='owner', banner_path=null where id=$1`, [A]));

// значок Tester
const testerSql = fs.readFileSync(path.join(migDir, '20261104000003_tester_badge.sql'), 'utf8');
const adminSql = fs.readFileSync(path.resolve(migDir, '..', 'admin', 'tester-badge.sql'), 'utf8');
const statements = adminSql.split(/;\s*\n/).map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
const adminLookup = statements[0], adminGrant = statements[1], adminRevoke = statements[3];
const fill = (sql, id) => sql.replace(/UUID_ДРУГА/g, id);
eq('owner kept after tester migration', await badgeOf(D), 'owner');
await expectErr('admin SQL with placeholder changes nothing', () => db.query(adminGrant));
eq('admin lookup is read only', /^select\b/i.test(adminLookup) && !/\b(update|insert|delete)\b/i.test(adminLookup), true);
const looked = (await db.query(adminLookup.replace('USERNAME_ДРУГА', 'NEW_USER_C'.toLowerCase()))).rows;
eq('admin lookup with unknown username finds nothing', looked.length, 0);
const nameOfA = (await db.query('select username from public.profiles where id=$1', [A])).rows[0].username;
const foundA = (await db.query(adminLookup.replace('USERNAME_ДРУГА', nameOfA))).rows;
eq('admin lookup finds exactly one account with its id and email', foundA.length === 1 && foundA[0].id === A && !!foundA[0].email, true);
eq('admin grant is bound to id, not username', /where id = /.test(adminGrant) && !/username\s*=/.test(adminGrant.split('where')[1]), true);
eq('admin grant returns the account', (await db.query(fill(adminGrant, A))).rows[0].username, (await db.query('select username from public.profiles where id=$1', [A])).rows[0].username);
eq('tester badge granted', await badgeOf(A), 'tester');
eq('several testers allowed', (await db.query(fill(adminGrant, B))).rows.length, 1);
eq('admin grant cannot replace owner', (await db.query(fill(adminGrant, D))).rows.length, 0);
eq('owner untouched by grant', await badgeOf(D), 'owner');
eq('admin revoke cannot remove owner', (await db.query(fill(adminRevoke, D))).rows.length, 0);
eq('owner untouched by revoke', await badgeOf(D), 'owner');
eq('unknown id grants nothing', (await db.query(fill(adminGrant, '00000000-0000-4000-8000-0000000000ff'))).rows.length, 0);
await expectErr('second owner rejected', () => db.exec(`update public.profiles set badge='owner' where id='${C}'`));
await expectErr('unknown badge rejected', () => db.exec(`update public.profiles set badge='admin' where id='${C}'`));
eq('tester visible to others', (await as(C, 'select badge from public.profiles where id=$1', [A])).rows[0].badge, 'tester');
await expectOk('tester renames self', () => as(A, `update public.profiles set username='renamed_tester' where id=$1`, [A]));
eq('tester survives rename', await badgeOf(A), 'tester');
await expectErr('C cannot grant self tester', () => as(C, `update public.profiles set badge='tester' where id=$1`, [C]));
await expectErr('C cannot grant self owner', () => as(C, `update public.profiles set badge='owner' where id=$1`, [C]));
await expectErr('tester cannot promote self to owner', () => as(A, `update public.profiles set badge='owner' where id=$1`, [A]));
await expectErr('tester cannot clear own badge', () => as(A, `update public.profiles set badge=null where id=$1`, [A]));
await expectErr('owner cannot grant tester to others', () => as(D, `update public.profiles set badge='tester' where id=$1`, [C]));
await expectErr('owner cannot change own badge', () => as(D, `update public.profiles set badge='tester' where id=$1`, [D]));
await expectErr('client cannot insert profile with badge', () => as(C, `insert into public.profiles (id, username, display_name, badge) values (gen_random_uuid(), 'fake_owner', 'x', 'owner')`));
await expectErr('client cannot upsert own badge', () => as(C, `insert into public.profiles (id, username, display_name, badge) values ($1, 'x_y_z', 'x', 'tester') on conflict (id) do update set badge='tester'`, [C]));
await as(A, `delete from public.profiles where id=$1`, [C]).catch(() => undefined);
eq('client cannot delete profile', (await db.query('select count(*)::int n from public.profiles where id=$1', [C])).rows[0].n, 1);
await expectErr('anonymous client cannot change badge', () => db.exec(`set role anon; update public.profiles set badge='owner' where id='${C}'`)).finally(() => db.exec('reset role'));
await db.exec('reset role');
eq('anonymous update changed nothing', await badgeOf(C), null);
// второй рубеж: триггер срабатывает, даже если разрешение на колонку выдали по ошибке
await db.exec('grant update (badge) on public.profiles to authenticated');
await expectErr('trigger blocks self-grant despite mistaken column grant', () => as(C, `update public.profiles set badge='tester' where id=$1`, [C]));
await expectErr('trigger blocks self-promotion despite mistaken column grant', () => as(A, `update public.profiles set badge='owner' where id=$1`, [A]));
await db.exec('revoke update (badge) on public.profiles from authenticated');
// регистрация и метаданные не дают значка
const F = '00000000-0000-4000-8000-00000000000f';
await db.exec(`insert into auth.users values ('${F}','f@x','{"username":"new_user_f","badge":"owner"}')`);
eq('signup metadata cannot set badge', await badgeOf(F), null);
await expectOk('regular profile edit still works', () => as(F, `update public.profiles set bio='привет', status='idle' where id=$1`, [F]));
// значок не даёт прав
const foreign = (await as(D, `select public.create_server('Чужой сервер') id`)).rows[0].id;
await expectErr('tester gets no rights on foreign server', () => as(A, `update public.servers set name='x' where id=$1`, [foreign]));
await expectErr('tester cannot create invite for foreign server', () => as(A, `select public.create_invite($1, 5, 24)`, [foreign]));
eq('tester does not see foreign server', (await as(A, 'select * from public.servers where id=$1', [foreign])).rows.length, 0);
// повторный запуск миграции и прежний скрипт владельца значки не меняют
await db.exec(testerSql);
await db.exec(badgeSql);
eq('re-run keeps owner', await badgeOf(D), 'owner');
eq('re-run keeps tester', await badgeOf(A), 'tester');
eq('admin revoke removes tester', (await db.query(fill(adminRevoke, A))).rows[0].badge, null);
eq('tester revoked', await badgeOf(A), null);
eq('second revoke does nothing', (await db.query(fill(adminRevoke, A))).rows.length, 0);

console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
