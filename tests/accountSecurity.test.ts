// Edge Function account-security (резервные коды 2FA) и ограничитель попыток в приложении.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { edge } from './helpers/supabaseEdgeStub';
import { AttemptLimiter } from '@/lib/attemptLimiter';

const env = new Map<string, string>();
let handler: (req: Request) => Promise<Response>;
Object.assign(globalThis, {
  Deno: {
    env: { get: (k: string) => env.get(k) },
    serve: (h: typeof handler) => {
      handler = h;
    },
  },
});

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (aal: 'aal1' | 'aal2') => `${b64({ alg: 'none' })}.${b64({ sub: ALICE, aal })}.sig-${aal}`;

async function call(token: string, body: Record<string, unknown>) {
  const res = await handler(new Request('https://x/functions/v1/account-security', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  await import('../supabase/functions/account-security/index.ts');
});

beforeEach(() => {
  env.clear();
  env.set('SUPABASE_URL', 'https://x.supabase.co');
  env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  edge.users.clear();
  edge.tables.clear();
  edge.factors.clear();
  edge.users.set(jwt('aal1'), ALICE);
  edge.users.set(jwt('aal2'), ALICE);
  edge.factors.set(ALICE, [{ id: 'f1', factor_type: 'totp', status: 'verified' }]);
});

describe('резервные коды 2FA', () => {
  it('создать коды можно только из сессии, подтверждённой 2FA', async () => {
    expect((await call(jwt('aal1'), { action: 'recovery_generate' })).status).toBe(403);
    const r = await call(jwt('aal2'), { action: 'recovery_generate' });
    expect(r.status).toBe(200);
    expect(r.body.codes).toHaveLength(10);
    expect(new Set(r.body.codes).size).toBe(10);
    for (const c of r.body.codes) expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    // В базе — только хэши, не сами коды
    const stored = edge.tables.get('mfa_recovery_codes')!;
    expect(stored).toHaveLength(10);
    expect(JSON.stringify(stored)).not.toContain(r.body.codes[0]);
    expect((await call(jwt('aal2'), { action: 'recovery_status' })).body.remaining).toBe(10);
  });

  it('вход по коду: код одноразовый, 2FA сбрасывается', async () => {
    const { codes } = (await call(jwt('aal2'), { action: 'recovery_generate' })).body;
    const r = await call(jwt('aal1'), { action: 'recovery_redeem', code: codes[3].toLowerCase() });
    expect(r.status).toBe(200);
    expect(edge.factors.get(ALICE)).toEqual([]);
    expect((await call(jwt('aal1'), { action: 'recovery_redeem', code: codes[3] })).status).toBe(403);
    expect((await call(jwt('aal2'), { action: 'recovery_status' })).body.remaining).toBe(9);
  });

  it('перебор: после 5 неверных кодов — 429, даже верный код не принимается', async () => {
    const { codes } = (await call(jwt('aal2'), { action: 'recovery_generate' })).body;
    for (let i = 0; i < 5; i++) expect((await call(jwt('aal1'), { action: 'recovery_redeem', code: 'AAAAA-AAAAA' })).status).toBe(403);
    const r = await call(jwt('aal1'), { action: 'recovery_redeem', code: codes[0] });
    expect(r.status).toBe(429);
    expect(edge.factors.get(ALICE)).toHaveLength(1);
  });

  it('без входа и с неверным форматом — отказ', async () => {
    expect((await call('garbage', { action: 'recovery_status' })).status).toBe(401);
    expect((await call(jwt('aal1'), { action: 'recovery_redeem', code: '123' })).status).toBe(400);
  });
});

describe('ограничитель попыток ввода кода', () => {
  it('5 ошибок бесплатно, затем нарастающая пауза; успех сбрасывает', () => {
    let t = 0;
    const l = new AttemptLimiter(5, 30_000, 15 * 60_000, () => t);
    for (let i = 0; i < 4; i++) l.fail();
    expect(l.wait()).toBe(0);
    l.fail();
    expect(l.wait()).toBe(30_000);
    t += 30_000;
    l.fail();
    expect(l.wait()).toBe(60_000);
    l.success();
    expect(l.wait()).toBe(0);
  });
});
