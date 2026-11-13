// Обращения к Edge Function voice-sfu (посредник к API Cloudflare Realtime SFU).
import { supabase } from '@/lib/supabase';
import { functionErrorMessage } from '@/lib/errors';
import type { IceServerLike } from './peer';
import type { Source } from './protocol';

export interface SessionGrant {
  id: string;
  token: string;
}

export interface JoinResult {
  room: string;
  can_speak: boolean;
  user_limit: number | null;
  ice_servers: IceServerLike[] | null;
  pub: SessionGrant | null;
  sub: SessionGrant | null;
}

export type JoinTarget = { kind: 'channel'; channelId: string } | { kind: 'dm'; dmId: string };

export interface VoiceApi {
  join(target: JoinTarget, scope?: 'all' | 'pub' | 'sub'): Promise<JoinResult>;
  publish(session: SessionGrant, sdp: string, tracks: { mid: string; source: Source }[]): Promise<{ sdp: string; tracks: { mid: string; source: Source; name: string }[] }>;
  unpublish(session: SessionGrant, sdp: string, mids: string[]): Promise<{ sdp: string }>;
  subscribe(
    session: SessionGrant,
    tracks: { session: string; name: string }[],
  ): Promise<{ sdp: string | null; renegotiate: boolean; tracks: { name: string; mid?: string; error?: string }[] }>;
  answer(session: SessionGrant, sdp: string): Promise<void>;
  unsubscribe(session: SessionGrant, sdp: string, mids: string[]): Promise<{ sdp: string }>;
  close(pub: { session: SessionGrant; mids: string[] } | null, sub: { session: SessionGrant; mids: string[] } | null): Promise<void>;
}

export class VoiceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'VoiceApiError';
  }
  /** Повтор имеет смысл: сеть, перегрузка или временный сбой */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('voice-sfu', { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    let code = 'error';
    try {
      code = ((await ctx?.clone().json()) as { error?: string } | undefined)?.error ?? code;
    } catch {
      /* тело не JSON */
    }
    throw new VoiceApiError(await functionErrorMessage(error), typeof ctx?.status === 'number' ? ctx.status : 0, code);
  }
  return data as T;
}

const grant = (s: SessionGrant) => ({ id: s.id, token: s.token });

export const voiceApi: VoiceApi = {
  join: (target, scope = 'all') =>
    invoke<JoinResult>({ action: 'join', scope, ...(target.kind === 'channel' ? { channel_id: target.channelId } : { dm_id: target.dmId }) }),
  publish: (session, sdp, tracks) => invoke({ action: 'publish', session: grant(session), sdp, tracks }),
  unpublish: (session, sdp, mids) => invoke({ action: 'unpublish', session: grant(session), sdp, mids }),
  subscribe: (session, tracks) => invoke({ action: 'subscribe', session: grant(session), tracks }),
  answer: async (session, sdp) => {
    await invoke({ action: 'answer', session: grant(session), sdp });
  },
  unsubscribe: (session, sdp, mids) => invoke({ action: 'unsubscribe', session: grant(session), sdp, mids }),
  close: async (pub, sub) => {
    const body: Record<string, unknown> = { action: 'close' };
    if (pub && pub.mids.length) body.pub = { ...grant(pub.session), mids: pub.mids };
    if (sub && sub.mids.length) body.sub = { ...grant(sub.session), mids: sub.mids };
    if (!body.pub && !body.sub) return;
    await invoke(body);
  },
};
