// Реальная проверка голосовой связи через Cloudflare Realtime SFU (npm run test:sfu-live).
//
// Что делает: в настоящем Chromium (Electron, скрытое окно) два участника входят в одну комнату,
// публикуют синтезированный звук и тестовое «демонстрационное» видео и принимают друг друга через
// НАСТОЯЩИЙ Cloudflare Realtime SFU. Сигнализация проходит через код Edge Function voice-sfu,
// запущенный локально (обращения к Cloudflare — настоящие). Подменены только проверки Supabase
// (JWT и права) — они покрыты npm run test:sql и тестами функции.
//
// Ключи берутся из локального файла .env.sfu-test (в .gitignore, в репозиторий не попадает):
//   CF_SFU_APP_ID=...
//   CF_SFU_APP_TOKEN=...
// Скрипт ключи не печатает.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const outDir = path.join(root, '.cache', 'sfu-smoke');

function loadEnv() {
  if (process.env.CF_SFU_APP_ID && process.env.CF_SFU_APP_TOKEN) return;
  const file = path.join(root, '.env.sfu-test');
  if (!fs.existsSync(file)) {
    console.error('Нет файла .env.sfu-test с CF_SFU_APP_ID и CF_SFU_APP_TOKEN (см. комментарий в scripts/sfu-smoke/main.cjs)');
    process.exit(2);
  }
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  if (!process.env.CF_SFU_APP_ID || !process.env.CF_SFU_APP_TOKEN) {
    console.error('В .env.sfu-test должны быть CF_SFU_APP_ID и CF_SFU_APP_TOKEN');
    process.exit(2);
  }
}

const srcAlias = {
  name: 'paths',
  setup(b) {
    b.onResolve({ filter: /^@\// }, (args) => {
      const base = path.join(root, 'src', args.path.slice(2));
      for (const c of [base + '.ts', base + '.tsx', path.join(base, 'index.ts')]) if (fs.existsSync(c)) return { path: c };
      return { path: base };
    });
    b.onResolve({ filter: /^npm:@supabase\/supabase-js/ }, () => ({ path: path.join(__dirname, 'supabaseStub.cjs') }));
  },
};

async function build() {
  const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
  fs.mkdirSync(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(root, 'supabase/functions/voice-sfu/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(outDir, 'function.cjs'),
    plugins: [srcAlias],
    logLevel: 'error',
  });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'page.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    outfile: path.join(outDir, 'page.js'),
    plugins: [srcAlias],
    logLevel: 'error',
  });
  fs.writeFileSync(
    path.join(outDir, 'page.html'),
    '<!doctype html><meta charset="utf-8"><title>sfu smoke</title><canvas id="c" width="640" height="360"></canvas><script src="page.js"></script>',
  );
}

loadEnv();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
  try {
    await build();
  } catch (e) {
    console.error('Сборка теста не удалась:', e.message);
    app.exit(2);
    return;
  }
  let handler = null;
  globalThis.Deno = {
    env: { get: (k) => process.env[k] },
    serve: (h) => {
      handler = h;
    },
  };
  require(path.join(outDir, 'function.cjs'));
  if (!handler) {
    console.error('Edge Function не зарегистрировала обработчик');
    app.exit(2);
    return;
  }
  ipcMain.handle('invoke', async (_e, user, body) => {
    const res = await handler(
      new Request('https://local.test/functions/v1/voice-sfu', {
        method: 'POST',
        headers: { Authorization: `Bearer user:${user}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json() };
  });
  ipcMain.on('log', (_e, msg) => console.log(msg));
  ipcMain.on('done', (_e, ok) => {
    console.log(ok ? '\nИТОГ: реальная связь через Cloudflare Realtime SFU работает' : '\nИТОГ: есть ошибки (см. выше)');
    app.exit(ok ? 0 : 1);
  });
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.webContents.on('console-message', (e) => {
    if (/error|failed/i.test(e.message)) console.log('[page]', e.message);
  });
  setTimeout(() => {
    console.error('Тайм-аут проверки (180 с)');
    app.exit(1);
  }, 180_000);
  await win.loadFile(path.join(outDir, 'page.html'));
});
