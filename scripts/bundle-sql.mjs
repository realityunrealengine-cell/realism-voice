// Склеивает все миграции в один файл supabase/setup.sql для вставки в SQL Editor.
// Запуск: npm run sql:bundle
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('supabase/migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const header = `-- =====================================================================
-- Realism Voice — полная настройка базы данных (сгенерировано из supabase/migrations)
-- Вставьте целиком в Supabase Dashboard → SQL Editor → Run.
-- Скрипт идемпотентен: повторный запуск безопасен и не удаляет данные.
-- =====================================================================
`;
const body = files.map((f) => `\n-- >>> ${f}\n${fs.readFileSync(path.join(dir, f), 'utf8')}`).join('\n');
fs.writeFileSync(path.resolve('supabase/setup.sql'), header + body, 'utf8');
console.log(`supabase/setup.sql: ${files.length} миграций`);
