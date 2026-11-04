// Публикация релиза в репозиторий обновлений. Все файлы загружаются в один черновик; пока его состав
// не проверен, пользователи ничего не видят. Сборка electron-builder здесь не публикует: при --publish always
// он может создать два черновика с одним тегом и разложить файлы по ним.
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

/** gh(args) выполняет команду GitHub CLI и возвращает её вывод */
export function publishRelease({ gh, tag, repo, dir, notesFile }) {
  const sameTag = () => JSON.parse(gh(['api', `repos/${repo}/releases?per_page=100`])).filter((r) => r.tag_name === tag);

  const existing = sameTag();
  if (existing.some((r) => !r.draft)) throw new Error(`Релиз ${tag} уже опубликован: изменять его автоматически нельзя.`);
  // Черновики прошлых неудачных запусков пользователям не видны и только мешают
  for (const draft of existing) gh(['api', '--method', 'DELETE', `repos/${repo}/releases/${draft.id}`]);

  gh(['release', 'create', tag, ...RELEASE_FILES.map((f) => path.join(dir, f)), '--repo', repo, '--draft', '--title', `Realism Voice ${tag}`, '--notes-file', notesFile]);

  const drafts = sameTag();
  if (drafts.length !== 1 || !drafts[0].draft) throw new Error(`Ожидался один черновик ${tag}, найдено: ${drafts.length}`);
  const draft = drafts[0];
  checkAssets(draft, dir);

  const manifestAsset = draft.assets.find((a) => a.name === 'latest.yml');
  const uploaded = gh(['api', '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${manifestAsset.id}`]);
  if (uploaded !== fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8')) throw new Error('Загруженный latest.yml отличается от подписанного.');

  gh(['api', '--method', 'PATCH', `repos/${repo}/releases/${draft.id}`, '-F', 'draft=false', '-f', 'make_latest=true']);

  const published = JSON.parse(gh(['api', `repos/${repo}/releases/${draft.id}`]));
  if (published.draft) throw new Error('Релиз остался черновиком.');
  checkAssets(published, dir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const channel = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build.publish[0];
  try {
    publishRelease({
      gh: (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }),
      tag: process.env.GITHUB_REF_NAME,
      repo: `${channel.owner}/${channel.repo}`,
      dir: path.join(root, 'release'),
      notesFile: path.join(root, 'build', 'release-notes.md'),
    });
    console.log(`Релиз ${process.env.GITHUB_REF_NAME} опубликован в ${channel.owner}/${channel.repo}`);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
