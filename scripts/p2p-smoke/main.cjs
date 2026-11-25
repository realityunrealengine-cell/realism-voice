// Реальная проверка P2P (npm run test:p2p-live): настоящий Chromium (Electron), настоящие RTCPeerConnection,
// настоящий STUN Cloudflare и — для проверки перехода на сервер — настоящий Cloudflare Realtime SFU
// (через локально запущенный код Edge Function voice-sfu, как в test:sfu-live).
//
// Что подменено: сигнализация Supabase Realtime (сервер presence/broadcast в памяти страницы) и проверки
// прав Supabase (покрыты test:sql). Оба участника работают на ЭТОМ компьютере — поэтому проверяется
// прямое соединение через локальную сеть/loopback и получение публичного адреса через STUN, но не
// прохождение двух разных NAT/CGNAT: для этого нужны два компьютера в разных сетях (README, раздел 6а).
//
// Ключи SFU (необязательно) — из .env.sfu-test, как у test:sfu-live. Без них часть с SFU пропускается.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const outDir = path.join(root, '.cache', 'p2p-smoke');
const sfuDir = path.join(root, 'scripts', 'sfu-smoke');

function loadEnv() {
  const file = path.join(root, '.env.sfu-test');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
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
    b.onResolve({ filter: /^npm:@supabase\/supabase-js/ }, () => ({ path: path.join(sfuDir, 'supabaseStub.cjs') }));
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
    define: { 'import.meta.env.DEV': 'false' },
    logLevel: 'error',
  });
  fs.writeFileSync(path.join(outDir, 'page.html'), '<!doctype html><meta charset="utf-8"><title>p2p smoke</title><script src="page.js"></script>');
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
  const haveSfu = !!(process.env.CF_SFU_APP_ID && process.env.CF_SFU_APP_TOKEN);
  if (haveSfu) {
    globalThis.Deno = { env: { get: (k) => process.env[k] }, serve: (h) => (handler = h) };
    require(path.join(outDir, 'function.cjs'));
  }
  ipcMain.handle('invoke', async (_e, user, body) => {
    if (!handler) return { status: 503, body: { error: 'no_sfu' } };
    const res = await handler(
      new Request('https://local.test/functions/v1/voice-sfu', {
        method: 'POST',
        headers: { Authorization: `Bearer user:${user}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json() };
  });
  ipcMain.handle('haveSfu', () => !!handler);
  ipcMain.on('log', (_e, msg) => console.log(msg));
  ipcMain.on('done', (_e, ok) => {
    console.log(ok ? '\nИТОГ: P2P-механизмы работают на реальном WebRTC' : '\nИТОГ: есть ошибки (см. выше)');
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
    if (/error|failed|uncaught/i.test(e.message)) console.log('[page]', e.message);
  });
  setTimeout(() => {
    console.error('Тайм-аут проверки (240 с)');
    app.exit(1);
  }, 240_000);
  await win.loadFile(path.join(outDir, 'page.html'), process.env.P2P_ONLY_MESSAGES ? { hash: 'messages' } : undefined);
});
