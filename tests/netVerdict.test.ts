import { describe, expect, it } from 'vitest';
import { netVerdict, verdictText, type NetFacts } from '../electron/netVerdict';

const healthy: NetFacts = {
  internetOk: true, dnsOk: true, dnsCode: null, tlsOk: true, tlsCode: null, httpStatus: 200,
  appOk: true, appError: null, proxy: 'DIRECT', wsOk: true, clockSkewSec: 2,
};

describe('причина «Нет соединения с сервером»', () => {
  it('всё работает', () => {
    expect(netVerdict(healthy)).toBe('ok');
  });

  it('нет интернета вообще', () => {
    expect(netVerdict({ ...healthy, internetOk: false, dnsOk: false, dnsCode: 'ENOTFOUND', tlsOk: false, tlsCode: 'ENOTFOUND', httpStatus: null, appOk: false, appError: 'ERR_INTERNET_DISCONNECTED', wsOk: false, clockSkewSec: null })).toBe('offline');
  });

  it('часы Windows сбиты — важнее всего остального', () => {
    const f = { ...healthy, appOk: false, clockSkewSec: 3 * 3600 };
    expect(netVerdict(f)).toBe('clock');
    expect(verdictText('clock', f).explain).toMatch(/180 мин/);
    expect(netVerdict({ ...healthy, appOk: false, httpStatus: null, tlsOk: false, tlsCode: 'CERT_NOT_YET_VALID', clockSkewSec: null })).toBe('clock');
  });

  it('DNS провайдера не отдаёт адрес сервера (как блокировка *.supabase.co в Индии)', () => {
    expect(netVerdict({ ...healthy, dnsOk: false, dnsCode: 'ENOTFOUND', tlsOk: false, tlsCode: 'ENOTFOUND', httpStatus: null, appOk: false, appError: 'ERR_NAME_NOT_RESOLVED', wsOk: false })).toBe('dns');
  });

  it('соединение рвётся при живом интернете — блокировка или фаервол', () => {
    const f = { ...healthy, tlsOk: false, tlsCode: 'ECONNRESET', httpStatus: null, appOk: false, appError: 'ERR_CONNECTION_RESET', wsOk: false };
    expect(netVerdict(f)).toBe('blocked');
    expect(verdictText('blocked', f).explain).toMatch(/ECONNRESET/);
    expect(netVerdict({ ...f, tlsCode: 'ETIMEDOUT' })).toBe('blocked');
  });

  it('антивирус подменяет сертификат', () => {
    expect(netVerdict({ ...healthy, tlsOk: false, tlsCode: 'SELF_SIGNED_CERT_IN_CHAIN', httpStatus: null, appOk: false, appError: 'ERR_CERT_AUTHORITY_INVALID' })).toBe('tls-intercept');
  });

  it('напрямую сервер отвечает, а через системный прокси — нет', () => {
    const f = { ...healthy, appOk: false, appError: 'ERR_PROXY_CONNECTION_FAILED', proxy: '127.0.0.1:8888' };
    expect(netVerdict(f)).toBe('proxy');
    expect(verdictText('proxy', f).explain).toMatch(/127\.0\.0\.1:8888/);
  });

  it('HTTP работает, WebSocket нет — «Синхронизация…» не проходит', () => {
    expect(netVerdict({ ...healthy, wsOk: false })).toBe('websocket');
  });

  it('сервер отвечает ошибкой 5xx — не вина пользователя', () => {
    expect(netVerdict({ ...healthy, httpStatus: 503, appOk: false, appError: 'HTTP 503' })).toBe('server');
  });

  it('у каждого итога есть понятный текст и шаги', () => {
    for (const v of ['ok', 'offline', 'clock', 'tls-intercept', 'dns', 'blocked', 'proxy', 'websocket', 'server', 'unknown'] as const) {
      const t = verdictText(v, healthy);
      expect(t.title.length).toBeGreaterThan(5);
      expect(t.steps.length).toBeGreaterThan(0);
    }
  });
});
