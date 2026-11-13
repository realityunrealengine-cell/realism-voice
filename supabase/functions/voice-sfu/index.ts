// Realism Voice — Edge Function: посредник между приложением и Cloudflare Realtime SFU.
//
// Голос и видео идут напрямую: приложение ⇄ Cloudflare Realtime SFU (WebRTC).
// Эта функция нужна только потому, что API SFU требует секрет приложения, который нельзя
// хранить в Electron. Она:
//   1. Проверяет JWT пользователя Supabase и его права (voice_access / dm_call_access —
//      те же правила, что и раньше для LiveKit; права перепроверяются при каждой публикации и подписке).
//   2. Создаёт сессии SFU и выдаёт к ним подписанный «ключ сессии» (HMAC): чужими сессиями
//      управлять нельзя.
//   3. Передаёт SDP offer/answer и команды публикации, подписки и закрытия треков в API SFU.
//      Имя трека содержит комнату, поэтому подписаться можно только на треки комнаты, к которой есть доступ.
//
// Ограничений числа участников, комнат, длительности или битрейта здесь нет. Лимит участников
// голосового канала задаёт только администратор сервера (user_limit), как и раньше.
//
// Секреты (Dashboard → Edge Functions → Secrets), в приложение и GitHub не попадают:
//   CF_SFU_APP_ID     — App ID приложения Realtime SFU
//   CF_SFU_APP_TOKEN  — App Secret (API token) приложения Realtime SFU
//   CF_TURN_KEY_ID, CF_TURN_KEY_API_TOKEN — необязательно: TURN Cloudflare для сетей, где UDP закрыт
//
// Файл самодостаточен — его можно вставить в редактор функций в Supabase Dashboard.
// Официальная документация API: https://developers.cloudflare.com/realtime/sfu/

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SFU_API = 'https://rtc.live.cloudflare.com/v1';
const STUN = { urls: 'stun:stun.cloudflare.com:3478' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOM_RE = /^(ch|dm)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const MID_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{8,128}$/;
const TRACK_RE = /^(ch|dm)_[0-9a-f-]{36}\.(mic|camera|screen|screenAudio)\.[A-Za-z0-9_-]{8,32}$/;
const SOURCES = ['mic', 'camera', 'screen', 'screenAudio'];
const MAX_SDP = 200 * 1024;
/** Cloudflare принимает до 64 треков в одном запросе tracks/new */
const MAX_TRACKS = 64;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

const bad = (message = 'Некорректный запрос') => new HttpError(400, 'bad_request', message);

// ---------- подписанный ключ сессии ----------
const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

let hmacKey: Promise<CryptoKey> | null = null;
function key(secret: string) {
  hmacKey ??= crypto.subtle.importKey('raw', enc.encode('rv-voice-session:' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return hmacKey;
}

interface Grant {
  s: string; // id сессии SFU
  u: string; // пользователь
  r: string; // комната
  k: 'pub' | 'sub';
}

async function sign(secret: string, g: Grant): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(g)));
  const mac = await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body));
  return `${body}.${b64url(mac)}`;
}

async function verify(secret: string, v: unknown, userId: string, kind: 'pub' | 'sub'): Promise<Grant> {
  const o = v as { id?: unknown; token?: unknown } | null;
  if (!o || typeof o.id !== 'string' || typeof o.token !== 'string' || o.token.length > 1024) throw bad('Нет ключа сессии');
  const [body, mac] = o.token.split('.');
  if (!body || !mac) throw new HttpError(403, 'bad_session', 'Ключ сессии недействителен');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await key(secret), fromB64url(mac), enc.encode(body));
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(403, 'bad_session', 'Ключ сессии недействителен');
  const g = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Grant;
  if (g.s !== o.id || g.u !== userId || g.k !== kind) throw new HttpError(403, 'bad_session', 'Сессия принадлежит другому пользователю');
  return g;
}

// ---------- API Cloudflare Realtime SFU ----------
class Sfu {
  constructor(
    private readonly appId: string,
    private readonly token: string,
  ) {}

  private async call(method: 'POST' | 'PUT', path: string, body?: unknown): Promise<Record<string, unknown>> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(`${SFU_API}/apps/${encodeURIComponent(this.appId)}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch {
      throw new HttpError(503, 'sfu_unreachable', 'Сервер Cloudflare Realtime недоступен. Повторите попытку.');
    } finally {
      clearTimeout(timer);
    }
    let data: Record<string, unknown> | null = null;
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      data = null;
    }
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(503, 'sfu_auth', 'Cloudflare Realtime отклонил ключи приложения. Проверьте секреты CF_SFU_APP_ID и CF_SFU_APP_TOKEN.');
    }
    if (!res.ok) console.warn('sfu http', res.status, path.replace(/sessions\/[^/]+/, 'sessions/…'), data?.errorCode, data?.errorDescription);
    if (res.status === 404 && path === '/sessions/new') {
      throw new HttpError(503, 'sfu_auth', 'Cloudflare Realtime не нашёл приложение SFU. Проверьте секрет CF_SFU_APP_ID.');
    }
    if (!res.ok) throw new HttpError(res.status === 404 || res.status === 410 ? 410 : 502, 'sfu_error', 'Cloudflare Realtime не выполнил операцию');
    if (!data || data.errorCode || data.errorDescription) {
      console.warn('sfu error', path, data?.errorCode, data?.errorDescription);
      throw new HttpError(502, 'sfu_error', 'Cloudflare Realtime не выполнил операцию');
    }
    return data;
  }

  async newSession(): Promise<string> {
    const r = await this.call('POST', '/sessions/new');
    if (typeof r.sessionId !== 'string') throw new HttpError(502, 'sfu_error', 'Cloudflare Realtime не создал сессию');
    return r.sessionId;
  }

  tracksNew(session: string, body: unknown) {
    return this.call('POST', `/sessions/${encodeURIComponent(session)}/tracks/new`, body);
  }

  renegotiate(session: string, sdp: string) {
    return this.call('PUT', `/sessions/${encodeURIComponent(session)}/renegotiate`, { sessionDescription: { type: 'answer', sdp } });
  }

  close(session: string, mids: string[], offer?: string) {
    const body: Record<string, unknown> = { tracks: mids.map((mid) => ({ mid })), force: !offer };
    if (offer) body.sessionDescription = { type: 'offer', sdp: offer };
    return this.call('PUT', `/sessions/${encodeURIComponent(session)}/tracks/close`, body);
  }
}

function trackErrors(r: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of Array.isArray(r.tracks) ? (r.tracks as Record<string, unknown>[]) : []) {
    if (t && (t.errorCode || t.errorDescription)) {
      const id = String(t.mid ?? t.trackName ?? '');
      out.set(id, typeof t.errorCode === 'string' ? t.errorCode.slice(0, 64) : 'track_error');
    }
  }
  return out;
}

function sdpOf(r: Record<string, unknown>, type: 'offer' | 'answer'): string {
  const sd = r.sessionDescription as { type?: string; sdp?: string } | undefined;
  if (!sd || sd.type !== type || typeof sd.sdp !== 'string') throw new HttpError(502, 'sfu_error', 'Cloudflare Realtime не вернул SDP');
  return sd.sdp;
}

const isSdp = (v: unknown): v is string => typeof v === 'string' && v.startsWith('v=0') && v.length <= MAX_SDP;
const isMids = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.length <= MAX_TRACKS && v.every((m) => typeof m === 'string' && MID_RE.test(m));

async function iceServers(): Promise<unknown[]> {
  const id = Deno.env.get('CF_TURN_KEY_ID') ?? '';
  const token = Deno.env.get('CF_TURN_KEY_API_TOKEN') ?? '';
  if (!id || !token) return [STUN];
  try {
    const res = await fetch(`${SFU_API}/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    });
    const data = (await res.json()) as { iceServers?: { urls: string | string[]; username?: string; credential?: string }[] | { urls: string | string[] } };
    const list = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
    // Порт 53 браузеры блокируют — без него не ждём таймаута
    const cleaned = list.map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)) }));
    return cleaned.length ? cleaned : [STUN];
  } catch {
    return [STUN];
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const appId = Deno.env.get('CF_SFU_APP_ID') ?? '';
  const appToken = Deno.env.get('CF_SFU_APP_TOKEN') ?? '';
  if (!appId || !appToken) {
    return json(503, {
      error: 'voice_not_configured',
      message: 'Голосовой сервер не настроен: задайте секреты CF_SFU_APP_ID и CF_SFU_APP_TOKEN для Edge Functions.',
    });
  }

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json(401, { error: 'unauthorized', message: 'Требуется авторизация' });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? req.headers.get('apikey') ?? '',
    {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    },
  );

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object') throw new Error();
  } catch {
    return json(400, { error: 'bad_request', message: 'Некорректный запрос' });
  }

  try {
    const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
    const userId = userData?.user?.id;
    if (userError || !userId) throw new HttpError(401, 'unauthorized', 'Сессия недействительна');

    /** Текущие права пользователя в комнате (проверяются при каждом обращении к SFU) */
    const access = async (room: string): Promise<{ canJoin: boolean; canSpeak: boolean; userLimit: number | null }> => {
      const m = ROOM_RE.exec(room);
      if (!m) throw bad('Некорректная комната');
      if (m[1] === 'ch') {
        const { data, error } = await supabase.rpc('voice_access', { p_channel: m[2] });
        if (error) throw new HttpError(500, 'db_error', error.message);
        const a = Array.isArray(data) ? data[0] : data;
        return { canJoin: !!a?.can_join, canSpeak: !!a?.can_join && !!a?.can_speak, userLimit: a?.user_limit ?? null };
      }
      const { data, error } = await supabase.rpc('dm_call_access', { p_dm: m[2] });
      if (error) throw new HttpError(500, 'db_error', error.message);
      return { canJoin: data === true, canSpeak: data === true, userLimit: null };
    };
    const forbidden = () => new HttpError(403, 'forbidden', 'Нет доступа к этому голосовому каналу');

    const sfu = new Sfu(appId, appToken);
    const action = body.action;

    if (action === 'join') {
      // Вход в комнату или замена сессий после сбоя соединения
      const channelId = typeof body.channel_id === 'string' ? body.channel_id : null;
      const dmId = typeof body.dm_id === 'string' ? body.dm_id : null;
      if ((channelId === null) === (dmId === null) || !UUID_RE.test(channelId ?? dmId ?? '')) throw bad('Укажите channel_id или dm_id');
      const room = channelId ? `ch_${channelId.toLowerCase()}` : `dm_${dmId!.toLowerCase()}`;
      const scope = body.scope === 'pub' || body.scope === 'sub' ? body.scope : 'all';
      const a = await access(room);
      if (!a.canJoin) {
        throw new HttpError(403, 'forbidden', dmId ? 'Звонок этому пользователю недоступен' : 'Нет доступа к этому голосовому каналу');
      }
      const wantPub = scope !== 'sub' && a.canSpeak;
      const wantSub = scope !== 'pub';
      const [pubId, subId, ice] = await Promise.all([
        wantPub ? sfu.newSession() : Promise.resolve(null),
        wantSub ? sfu.newSession() : Promise.resolve(null),
        scope === 'all' ? iceServers() : Promise.resolve(null),
      ]);
      return json(200, {
        room,
        can_speak: a.canSpeak,
        user_limit: a.userLimit,
        ice_servers: ice,
        pub: pubId ? { id: pubId, token: await sign(appToken, { s: pubId, u: userId, r: room, k: 'pub' }) } : null,
        sub: subId ? { id: subId, token: await sign(appToken, { s: subId, u: userId, r: room, k: 'sub' }) } : null,
      });
    }

    if (action === 'publish') {
      const g = await verify(appToken, body.session, userId, 'pub');
      const tracks = body.tracks;
      if (!isSdp(body.sdp) || !Array.isArray(tracks) || tracks.length === 0 || tracks.length > SOURCES.length) throw bad();
      const list = tracks.map((t) => t as { mid?: unknown; source?: unknown });
      if (!list.every((t) => typeof t.mid === 'string' && MID_RE.test(t.mid) && SOURCES.includes(t.source as string))) throw bad();
      if (!(await access(g.r)).canSpeak) throw new HttpError(403, 'forbidden', 'В этом канале у вас режим слушателя');
      const named = list.map((t) => ({
        mid: t.mid as string,
        source: t.source as string,
        name: `${g.r}.${t.source}.${b64url(crypto.getRandomValues(new Uint8Array(9)))}`,
      }));
      const r = await sfu.tracksNew(g.s, {
        sessionDescription: { type: 'offer', sdp: body.sdp },
        tracks: named.map((t) => ({ location: 'local', mid: t.mid, trackName: t.name })),
      });
      const errors = trackErrors(r);
      if (errors.size) {
        const ok = named.filter((t) => !errors.has(t.mid) && !errors.has(t.name)).map((t) => t.mid);
        if (ok.length) await sfu.close(g.s, ok).catch(() => undefined);
        throw new HttpError(502, 'publish_failed', 'Cloudflare Realtime не принял трек');
      }
      return json(200, { sdp: sdpOf(r, 'answer'), tracks: named });
    }

    if (action === 'subscribe') {
      const g = await verify(appToken, body.session, userId, 'sub');
      const tracks = body.tracks;
      if (!Array.isArray(tracks) || tracks.length === 0 || tracks.length > MAX_TRACKS) throw bad();
      const list = tracks.map((t) => t as { session?: unknown; name?: unknown });
      if (!list.every((t) => typeof t.session === 'string' && SESSION_RE.test(t.session) && typeof t.name === 'string' && TRACK_RE.test(t.name))) throw bad();
      // Подписка возможна только на треки своей комнаты: имя трека содержит комнату и задаётся этой функцией
      if (!list.every((t) => (t.name as string).startsWith(g.r + '.'))) throw forbidden();
      if (!(await access(g.r)).canJoin) throw forbidden();
      const r = await sfu.tracksNew(g.s, {
        tracks: list.map((t) => ({ location: 'remote', sessionId: t.session, trackName: t.name })),
      });
      const items = Array.isArray(r.tracks) ? (r.tracks as Record<string, unknown>[]) : [];
      const result = list.map((t) => {
        const it = items.find((x) => x?.trackName === t.name);
        const mid = typeof it?.mid === 'string' ? it.mid : undefined;
        const error = !it ? 'missing' : it.errorCode || it.errorDescription || !mid ? String(it.errorCode ?? 'track_error').slice(0, 64) : undefined;
        return { name: t.name as string, mid, error };
      });
      const renegotiate = r.requiresImmediateRenegotiation === true;
      return json(200, { sdp: renegotiate ? sdpOf(r, 'offer') : null, renegotiate, tracks: result });
    }

    if (action === 'answer') {
      const g = await verify(appToken, body.session, userId, 'sub');
      if (!isSdp(body.sdp)) throw bad();
      await sfu.renegotiate(g.s, body.sdp);
      return json(200, { ok: true });
    }

    if (action === 'unpublish' || action === 'unsubscribe') {
      // Согласованное закрытие: SDP-предложение клиента с остановленными трансиверами → ответ SFU
      const g = await verify(appToken, body.session, userId, action === 'unpublish' ? 'pub' : 'sub');
      if (!isSdp(body.sdp) || !isMids(body.mids)) throw bad();
      const r = await sfu.close(g.s, body.mids, body.sdp);
      return json(200, { sdp: sdpOf(r, 'answer') });
    }

    if (action === 'close') {
      // Принудительное закрытие при выходе (без SDP): пересылка медиа прекращается сразу
      const out: Promise<unknown>[] = [];
      for (const [k, kind] of [['pub', 'pub'], ['sub', 'sub']] as const) {
        const s = body[k] as { id?: unknown; token?: unknown; mids?: unknown } | undefined;
        if (!s) continue;
        const g = await verify(appToken, s, userId, kind);
        if (isMids(s.mids)) out.push(sfu.close(g.s, s.mids).catch(() => undefined));
      }
      await Promise.all(out);
      return json(200, { ok: true });
    }

    throw bad('Неизвестное действие');
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.code, message: e.message });
    console.error('voice-sfu', e);
    return json(500, { error: 'internal', message: 'Внутренняя ошибка голосового сервера' });
  }
});
