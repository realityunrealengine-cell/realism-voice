// Публикация релиза в репозиторий обновлений. Все файлы загружаются в один черновик; пока его состав
// не проверен, пользователи ничего не видят. Сборка electron-builder здесь не публикует: при --publish always
// он может создать два черновика с одним тегом и разложить файлы по ним.
//   без аргументов — публикация версии из тега GITHUB_REF_NAME
//   --rehearse     — репетиция для Dry run: те же шаги загрузки, но черновик удаляется и ничего не публикуется
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RELEASE_FILES = ['RealismVoice-Setup.exe', 'RealismVoice-Setup.exe.blockmap', 'latest.yml'];

function checkAssets(release, dir) {
  const assets = release.assets ?? [];
  if (assets.length !== RELEASE_FILES.length) throw new Error(`В релизе ${assets.length} файл(ов) вместо ${RELEASE_FILES.length}: ${assets.map((a) => a.name).join(', ')}`);
  for (const name of RELEASE_FILES) {
    const asset = assets.find((a) => a.name === name);
    if (!asset) throw new Error(`В релизе нет файла ${name}`);
    if (asset.state !== 'uploaded') throw new Error(`Файл ${name} загружен не полностью (${asset.state})`);
    const size = fs.statSync(path.join(dir, name)).size;
    if (asset.size !== size) throw new Error(`Размер ${name} на GitHub (${asset.size}) не совпадает с локальным (${size})`);
  }
}

function releasesWithTag(gh, repo, tag) {
  return JSON.parse(gh(['api', `repos/${repo}/releases?per_page=100`])).filter((r) => r.tag_name === tag);
}

function deleteRelease(gh, repo, release) {
  gh(['api', '--method', 'DELETE', `repos/${repo}/releases/${release.id}`]);
}

function uploadDraft({ gh, tag, repo, dir, notesFile }) {
  const existing = releasesWithTag(gh, repo, tag);
  if (existing.some((r) => !r.draft)) throw new Error(`Релиз ${tag} уже опубликован: изменять его автоматически нельзя.`);
  // Черновики прошлых неудачных запусков пользователям не видны и только мешают
  for (const draft of existing) deleteRelease(gh, repo, draft);

  gh(['release', 'create', tag, ...RELEASE_FILES.map((f) => path.join(dir, f)), '--repo', repo, '--draft', '--title', `Realism Voice ${tag}`, '--notes-file', notesFile]);

  const drafts = releasesWithTag(gh, repo, tag);
  if (drafts.length !== 1 || !drafts[0].draft) throw new Error(`Ожидался один черновик ${tag}, найдено: ${drafts.length}`);
  const draft = drafts[0];
  checkAssets(draft, dir);

  const manifestAsset = draft.assets.find((a) => a.name === 'latest.yml');
  const uploaded = gh(['api', '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${manifestAsset.id}`]);
  if (uploaded !== fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8')) throw new Error('Загруженный latest.yml отличается от подписанного.');
  return draft;
}

/** gh(args) выполняет команду GitHub CLI и возвращает её вывод */
export function publishRelease(options) {
  const { gh, repo, dir } = options;
  const draft = uploadDraft(options);
  gh(['api', '--method', 'PATCH', `repos/${repo}/releases/${draft.id}`, '-F', 'draft=false', '-f', 'make_latest=true']);

  const published = JSON.parse(gh(['api', `repos/${repo}/releases/${draft.id}`]));
  if (published.draft) throw new Error('Релиз остался черновиком.');
  checkAssets(published, dir);
}

/** Проверяет токен, загрузку и состав файлов на настоящем GitHub. Публикации нет, черновик удаляется всегда */
export function rehearseRelease(options) {
  const { gh, tag, repo } = options;
  if (!tag.startsWith('dry-run-')) throw new Error(`Для репетиции нужен тег dry-run-…, получен ${tag}`);
  try {
    uploadDraft(options);
  } finally {
    for (const release of releasesWithTag(gh, repo, tag)) {
      if (release.draft) deleteRelease(gh, repo, release);
    }
  }
  if (releasesWithTag(gh, repo, tag).length > 0) throw new Error(`Черновик ${tag} не удалён.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const channel = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build.publish[0];
  const rehearse = process.argv.includes('--rehearse');
  const tag = rehearse ? `dry-run-${process.env.GITHUB_RUN_ID}` : process.env.GITHUB_REF_NAME;
  const options = {
    gh: (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }),
    tag,
    repo: `${channel.owner}/${channel.repo}`,
    dir: path.join(root, 'release'),
    notesFile: path.join(root, 'build', 'release-notes.md'),
  };
  try {
    if (rehearse) rehearseRelease(options);
    else publishRelease(options);
    console.log(rehearse ? `Репетиция прошла: файлы загружены в ${options.repo}, черновик удалён, релиз не создан` : `Релиз ${tag} опубликован в ${options.repo}`);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
