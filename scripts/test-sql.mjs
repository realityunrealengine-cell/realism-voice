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
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
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
await expectOk('A can attach own path', () => as(A, `insert into public.messages (channel_id, content, attachments) values ($1, '', $2)`, [text, JSON.stringify([{ path: `channels/${text}/${A}/x.png`, name: 'x.png', size: 10, mime: 'image/png', width: 5 }])]));

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

console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
