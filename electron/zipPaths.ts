// Безопасные имена путей внутри ZIP-архивов папок (общий код main-процесса и тестов).
// Защищает от выхода за пределы папки назначения (zip-slip): абсолютные пути, «..», буквы дисков,
// альтернативные потоки NTFS («file:stream»), зарезервированные имена Windows, управляющие символы.

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const INVALID_CHARS = /[<>:"|?*\u0000-\u001f]/g;

export const MAX_SEGMENT_LENGTH = 200;
export const MAX_ENTRY_PATH_LENGTH = 1000;

/** Очистить один компонент пути (имя файла или папки) для Windows */
export function sanitizeSegment(raw: string): string {
  let s = raw.normalize('NFC').replace(INVALID_CHARS, '_');
  // Windows не допускает точки и пробелы в конце имени
  s = s.replace(/[. ]+$/g, '');
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  if (s.length > MAX_SEGMENT_LENGTH) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
    s = s.slice(0, MAX_SEGMENT_LENGTH - ext.length) + ext;
  }
  return s;
}

/**
 * Разобрать имя записи архива в безопасный список компонентов.
 * Возвращает null для записей, которые нельзя распаковывать.
 */
export function safeEntrySegments(entryName: string): string[] | null {
  if (typeof entryName !== 'string' || entryName.length === 0 || entryName.length > MAX_ENTRY_PATH_LENGTH) return null;
  if (/[\u0000]/.test(entryName)) return null;
  const name = entryName.replace(/\\/g, '/');
  // Абсолютные пути, UNC и буквы дисков
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.startsWith('//')) return null;
  const parts = name.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const out: string[] = [];
  for (const p of parts) {
    if (p === '.' ) continue;
    if (p === '..') return null;
    // Альтернативный поток NTFS или буква диска внутри пути
    if (p.includes(':')) return null;
    const clean = sanitizeSegment(p);
    if (!clean || clean === '.' || clean === '..') return null;
    out.push(clean);
  }
  return out.length ? out : null;
}

/** Имя записи для архива из относительного пути на диске (разделитель «/», NFC) */
export function entryNameFromRelative(rel: string, isDir: boolean): string {
  const parts = rel.split(/[\\/]+/).filter(Boolean).map((p) => p.normalize('NFC'));
  const name = parts.join('/');
  return isDir ? `${name}/` : name;
}

/** Проверка, что target лежит внутри root (оба пути уже абсолютные и нормализованные) */
export function isInside(root: string, target: string, caseInsensitive = true): boolean {
  const norm = (s: string) => (caseInsensitive ? s.toLowerCase() : s).replace(/[\\/]+$/, '');
  const r = norm(root);
  const t = norm(target);
  return t.startsWith(`${r}\\`) || t.startsWith(`${r}/`);
}

/** Уникальное имя папки/файла: «Имя», «Имя (2)», «Имя (3)»… */
export function uniqueName(base: string, exists: (name: string) => boolean): string {
  if (!exists(base)) return base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let i = 2; i < 10000; i++) {
    const n = `${stem} (${i})${ext}`;
    if (!exists(n)) return n;
  }
  return `${stem} (${Date.now()})${ext}`;
}
