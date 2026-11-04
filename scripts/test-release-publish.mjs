// Проверка publish-release.mjs на макете GitHub CLI: неполный релиз не должен стать видимым пользователям.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishRelease, RELEASE_FILES } from './publish-release.mjs';

const TAG = 'v1.0.4';
const REPO = 'owner/repo';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-publish-test-'));
const sizes = { 'RealismVoice-Setup.exe': 1000, 'RealismVoice-Setup.exe.blockmap': 20, 'latest.yml': 0 };
fs.writeFileSync(path.join(dir, 'RealismVoice-Setup.exe'), Buffer.alloc(1000));
fs.writeFileSync(path.join(dir, 'RealismVoice-Setup.exe.blockmap'), Buffer.alloc(20));
fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 1.0.4\nrvSignature: abc\n');
sizes['latest.yml'] = fs.statSync(path.join(dir, 'latest.yml')).size;
const notesFile = path.join(dir, 'notes.md');
fs.writeFileSync(notesFile, 'Версия 1.0.4');

function fakeGitHub({ releases = [], onCreate, manifest, failPublish = false } = {}) {
  const state = { releases: [...releases], calls: [], published: false };
  let nextId = 100;
  const gh = (args) => {
    state.calls.push(args.join(' '));
    if (args[0] === 'release' && args[1] === 'create') {
      assert.equal(args[2], TAG);
      assert.ok(args.includes('--draft'), 'черновик обязателен');
      const uploaded = args.slice(3, args.indexOf('--repo')).map((f) => path.basename(f));
      const assets = uploaded.map((name) => ({ id: nextId++, name, size: sizes[name], state: 'uploaded' }));
      const release = { id: nextId++, tag_name: TAG, draft: true, assets };
      state.releases.push(release);
      onCreate?.(state, release);
      return '';
    }
    if (args[0] === 'api' && args[1] === '-H') return manifest ?? fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'DELETE') {
      const id = Number(args[3].split('/').pop());
      state.releases = state.releases.filter((r) => r.id !== id);
      return '';
    }
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'PATCH') {
      if (failPublish) throw new Error('GitHub недоступен');
      state.releases.find((r) => r.id === Number(args[3].split('/').pop())).draft = false;
      state.published = true;
      return '{}';
    }
    if (args[0] === 'api' && args[1].includes('/releases?')) return JSON.stringify(state.releases);
    if (args[0] === 'api') return JSON.stringify(state.releases.find((r) => r.id === Number(args[1].split('/').pop())));
    throw new Error(`Неожиданная команда: ${args.join(' ')}`);
  };
  return { state, gh };
}

const run = (gh) => publishRelease({ gh, tag: TAG, repo: REPO, dir, notesFile });
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  OK   ${name}`);
  } catch (err) {
    failed++;
    console.log(` FAIL  ${name} — ${err.message}`);
  }
}

test('все файлы загружаются одной командой и релиз публикуется', () => {
  const { state, gh } = fakeGitHub();
  run(gh);
  assert.equal(state.calls.filter((c) => c.startsWith('release create')).length, 1);
  const created = state.calls.find((c) => c.startsWith('release create'));
  for (const f of RELEASE_FILES) assert.ok(created.includes(f), f);
  assert.equal(state.published, true);
  assert.equal(state.releases[0].assets.length, 3);
});

test('черновики прошлых запусков удаляются', () => {
  const { state, gh } = fakeGitHub({ releases: [{ id: 1, tag_name: TAG, draft: true, assets: [] }, { id: 2, tag_name: TAG, draft: true, assets: [] }, { id: 3, tag_name: 'v1.0.3', draft: true, assets: [] }] });
  run(gh);
  assert.equal(state.releases.filter((r) => r.tag_name === TAG).length, 1);
  assert.ok(state.releases.some((r) => r.id === 3), 'черновик другой версии не тронут');
});

test('опубликованный релиз не изменяется и не удаляется', () => {
  const { state, gh } = fakeGitHub({ releases: [{ id: 1, tag_name: TAG, draft: false, assets: [] }, { id: 2, tag_name: TAG, draft: true, assets: [] }] });
  assert.throws(() => run(gh), /уже опубликован/);
  assert.equal(state.releases.length, 2);
  assert.equal(state.calls.length, 1, 'кроме чтения команд нет');
});

for (const missing of RELEASE_FILES) {
  test(`без файла ${missing} релиз не публикуется`, () => {
    const { state, gh } = fakeGitHub({ onCreate: (_s, r) => { r.assets = r.assets.filter((a) => a.name !== missing); } });
    assert.throws(() => run(gh));
    assert.equal(state.published, false);
  });
}

test('появление второго черновика останавливает публикацию', () => {
  const { state, gh } = fakeGitHub({ onCreate: (s) => s.releases.push({ id: 999, tag_name: TAG, draft: true, assets: [] }) });
  assert.throws(() => run(gh), /один черновик/);
  assert.equal(state.published, false);
});

test('неверный размер файла останавливает публикацию', () => {
  const { state, gh } = fakeGitHub({ onCreate: (_s, r) => { r.assets[0].size = 1; } });
  assert.throws(() => run(gh), /Размер/);
  assert.equal(state.published, false);
});

test('незавершённая загрузка останавливает публикацию', () => {
  const { state, gh } = fakeGitHub({ onCreate: (_s, r) => { r.assets[0].state = 'starter'; } });
  assert.throws(() => run(gh), /не полностью/);
  assert.equal(state.published, false);
});

test('изменённый latest.yml останавливает публикацию', () => {
  const { state, gh } = fakeGitHub({ manifest: 'version: 9.9.9\n' });
  assert.throws(() => run(gh), /отличается/);
  assert.equal(state.published, false);
});

test('сбой публикации возвращает ошибку', () => {
  const { gh } = fakeGitHub({ failPublish: true });
  assert.throws(() => run(gh), /недоступен/);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `Не пройдено: ${failed}` : 'Все проверки пройдены.');
process.exit(failed ? 1 : 0);
