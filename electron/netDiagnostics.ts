// Диагностика «Нет соединения с сервером»: по шагам проверяет путь от компьютера до Supabase.
// Ничего не меняет в системе. В отчёт не попадают ключи и токены.
import { app, ipcMain, IpcMainInvokeEvent, net, session } from 'electron';
import dns from 'node:dns';
import https from 'node:https';
import tls from 'node:tls';
import type { NetCheck, NetReport } from './shared';
import { netVerdict, type NetFacts } from './netVerdict';

const STEP_TIMEOUT_MS = 8000;

function withTimeout<T>(p: Promise<T>, ms = STEP_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function errCode(e: unknown): string {
  const x = e as { code?: string; message?: string; cause?: { code?: string } };
  return x?.code || x?.cause?.code || (x?.message ?? 'error').slice(0, 80);
}

/** Прямой HTTPS-запрос средствами Node (без системного прокси) */
function directGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; date: string | null }> {
  return withTimeout(new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: STEP_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, date: (res.headers.date as string | undefined) ?? null });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  }));
}

function tlsProbe(host: string): Promise<void> {
  return withTimeout(new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: STEP_TIMEOUT_MS }, () => {
      sock.end();
      resolve();
    });
    sock.on('timeout', () => sock.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    sock.on('error', reject);
  }));
}

function wsProbe(url: string): Promise<boolean | null> {
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try { ws.close(); } catch { /* ignore */ }
      resolve(v);
    };
    const ws = new WS(url);
    const t = setTimeout(() => finish(false), STEP_TIMEOUT_MS);
    ws.onopen = () => finish(true);
    ws.onerror = () => finish(false);
  });
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; value?: T; code?: string }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - t0, value };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, code: errCode(e) };
  }
}

export async function diagnose(serverUrl: string, apiKey: string): Promise<NetReport> {
  const u = new URL(serverUrl);
  if (u.protocol !== 'https:') throw new Error('Недопустимый адрес сервера');
  const host = u.hostname;
  const health = `${u.origin}/auth/v1/health`;
  const headers: Record<string, string> = apiKey ? { apikey: apiKey } : {};

  const [google, cloudflare, dnsRes, tlsRes, httpRes, appRes, proxy, wsRes] = await Promise.all([
    timed(() => directGet('https://www.google.com/generate_204')),
    timed(() => directGet('https://www.cloudflare.com/cdn-cgi/trace')),
    timed(() => withTimeout(dns.promises.lookup(host, { all: true }))),
    timed(() => tlsProbe(host)),
    timed(() => directGet(health, headers)),
    timed(() => withTimeout(net.fetch(health, { headers }).then((r) => r.status))),
    session.defaultSession.resolveProxy(u.origin).catch(() => 'unknown'),
    timed(() => wsProbe(`wss://${host}/realtime/v1/websocket?apikey=${encodeURIComponent(apiKey)}&vsn=1.0.0`)),
  ]);

  const internetOk = (google.ok && (google.value?.status ?? 0) < 400) || (cloudflare.ok && (cloudflare.value?.status ?? 0) < 400);
  const serverDate = httpRes.value?.date ?? google.value?.date ?? cloudflare.value?.date ?? null;
  const clockSkewSec = serverDate ? Math.round((Date.now() - Date.parse(serverDate)) / 1000) : null;
  const appStatus = appRes.ok ? (appRes.value as number) : null;
  const facts: NetFacts = {
    internetOk,
    dnsOk: dnsRes.ok,
    dnsCode: dnsRes.ok ? null : dnsRes.code ?? null,
    tlsOk: tlsRes.ok,
    tlsCode: tlsRes.ok ? null : tlsRes.code ?? null,
    httpStatus: httpRes.ok ? httpRes.value!.status : null,
    appOk: appStatus !== null && appStatus < 500,
    appError: appRes.ok ? (appStatus !== null && appStatus >= 500 ? `HTTP ${appStatus}` : null) : appRes.code ?? 'error',
    proxy: proxy === 'DIRECT' ? 'DIRECT' : proxy.replace(/^PROXY\s+/i, '').split(';')[0].trim() || proxy,
    wsOk: wsRes.ok ? (wsRes.value ?? null) : false,
    clockSkewSec,
  };

  const checks: NetCheck[] = [
    { id: 'internet', label: 'Интернет (Google, Cloudflare)', ok: internetOk, ms: Math.min(google.ms, cloudflare.ms), detail: internetOk ? null : `${google.code ?? ''} ${cloudflare.code ?? ''}`.trim() },
    { id: 'dns', label: 'DNS находит сервер', ok: dnsRes.ok, ms: dnsRes.ms, detail: dnsRes.ok ? null : dnsRes.code ?? null },
    { id: 'tls', label: 'Защищённое соединение с сервером', ok: tlsRes.ok, ms: tlsRes.ms, detail: tlsRes.ok ? null : tlsRes.code ?? null },
    { id: 'http', label: 'Сервер отвечает', ok: httpRes.ok && httpRes.value!.status < 500, ms: httpRes.ms, detail: httpRes.ok ? `HTTP ${httpRes.value!.status}` : httpRes.code ?? null },
    { id: 'app', label: 'Подключение приложения (с учётом прокси)', ok: facts.appOk, ms: appRes.ms, detail: facts.appError },
    { id: 'ws', label: 'Мгновенная синхронизация (WebSocket)', ok: facts.wsOk !== false, ms: wsRes.ms, detail: facts.wsOk === false ? 'не подключается' : facts.wsOk === null ? 'не проверялась' : null },
    { id: 'clock', label: 'Время на компьютере', ok: clockSkewSec === null || Math.abs(clockSkewSec) <= 300, ms: 0, detail: clockSkewSec === null ? 'не удалось сверить' : `${clockSkewSec > 0 ? '+' : ''}${clockSkewSec} с` },
  ];

  return {
    at: new Date().toISOString(),
    appVersion: app.getVersion(),
    platform: `${process.platform} ${process.getSystemVersion()}`,
    host,
    proxy: facts.proxy,
    verdict: netVerdict(facts),
    facts,
    checks,
  };
}

export function setupNetDiagnostics(assertSender: (e: IpcMainInvokeEvent) => boolean) {
  let running: Promise<NetReport> | null = null;
  ipcMain.handle('net:diagnose', async (e, serverUrl: unknown, apiKey: unknown) => {
    if (!assertSender(e) || typeof serverUrl !== 'string' || typeof apiKey !== 'string' || apiKey.length > 300) throw new Error('Некорректный запрос');
    running ??= diagnose(serverUrl, apiKey).finally(() => {
      running = null;
    });
    return running;
  });
}
