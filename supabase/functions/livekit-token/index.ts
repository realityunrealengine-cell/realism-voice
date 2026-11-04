// Realism Voice — Edge Function: выдача LiveKit access token.
//
// Проверяет:
//   1. JWT пользователя Supabase (через auth.getUser).
//   2. Членство в сервере и доступ к голосовому каналу (RPC voice_access, выполняется
//      от имени пользователя — с учётом RLS и приватности канала).
//   3. Для личных звонков — участие в переписке и отсутствие блокировок (dm_call_access).
//   4. Лимит участников голосового канала (через LiveKit RoomService).
//
// Секреты (задаются только на сервере: Dashboard → Edge Functions → Secrets):
//   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
//
// Файл самодостаточен — его можно вставить в редактор функций в Supabase Dashboard.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { AccessToken, RoomServiceClient, TrackSource } from 'npm:livekit-server-sdk@2';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const livekitUrl = Deno.env.get('LIVEKIT_URL') ?? '';
  const apiKey = Deno.env.get('LIVEKIT_API_KEY') ?? '';
  const apiSecret = Deno.env.get('LIVEKIT_API_SECRET') ?? '';
  if (!livekitUrl || !apiKey || !apiSecret) {
    return json(503, {
      error: 'livekit_not_configured',
      message: 'Сервер голосовой связи не настроен: задайте секреты LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET для Edge Functions.',
    });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json(401, { error: 'unauthorized', message: 'Требуется авторизация' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseKey =
    Deno.env.get('SUPABASE_ANON_KEY') ??
    Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ??
    req.headers.get('apikey') ??
    '';
  const supabase = createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
  const user = userData?.user;
  if (userError || !user) return json(401, { error: 'unauthorized', message: 'Сессия недействительна' });

  let body: { channel_id?: unknown; dm_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'bad_request', message: 'Некорректный запрос' });
  }
  const channelId = typeof body.channel_id === 'string' ? body.channel_id : null;
  const dmId = typeof body.dm_id === 'string' ? body.dm_id : null;
  if ((channelId === null) === (dmId === null)) {
    return json(400, { error: 'bad_request', message: 'Укажите channel_id или dm_id' });
  }
  if (!UUID_RE.test(channelId ?? dmId ?? '')) {
    return json(400, { error: 'bad_request', message: 'Некорректный идентификатор' });
  }

  let roomName: string;
  let canSpeak = true;
  let userLimit: number | null = null;

  if (channelId) {
    const { data, error } = await supabase.rpc('voice_access', { p_channel: channelId });
    const access = Array.isArray(data) ? data[0] : data;
    if (error) return json(500, { error: 'db_error', message: error.message });
    if (!access || !access.can_join) {
      return json(403, { error: 'forbidden', message: 'Нет доступа к этому голосовому каналу' });
    }
    canSpeak = Boolean(access.can_speak);
    userLimit = access.user_limit ?? null;
    roomName = `ch_${channelId}`;
  } else {
    const { data, error } = await supabase.rpc('dm_call_access', { p_dm: dmId });
    if (error) return json(500, { error: 'db_error', message: error.message });
    if (data !== true) return json(403, { error: 'forbidden', message: 'Звонок этому пользователю недоступен' });
    roomName = `dm_${dmId}`;
    userLimit = 2;
  }

  if (userLimit) {
    try {
      const httpUrl = livekitUrl.replace(/^ws(s?):\/\//i, 'http$1://');
      const rooms = new RoomServiceClient(httpUrl, apiKey, apiSecret);
      const participants = await rooms.listParticipants(roomName);
      const others = participants.filter((p) => p.identity !== user.id);
      if (others.length >= userLimit) {
        return json(409, { error: 'room_full', message: 'Канал заполнен' });
      }
    } catch {
      // Комната ещё не создана — участников нет.
    }
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('username, display_name, avatar_path')
    .eq('id', user.id)
    .single();

  const at = new AccessToken(apiKey, apiSecret, {
    identity: user.id,
    name: profile?.display_name ?? 'Пользователь',
    ttl: '6h',
    metadata: JSON.stringify({
      username: profile?.username ?? null,
      avatar_path: profile?.avatar_path ?? null,
    }),
  });
  at.addGrant({
    room: roomName,
    roomJoin: true,
    canSubscribe: true,
    canPublish: canSpeak,
    canPublishData: true,
    canUpdateOwnMetadata: false,
    canPublishSources: canSpeak
      ? [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
      : [],
  });

  return json(200, { token: await at.toJwt(), url: livekitUrl, room: roomName, can_speak: canSpeak });
});
