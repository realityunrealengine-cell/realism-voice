// Состав комнаты, подписки, DTX и качество соединения — чистая логика клиента Cloudflare Realtime SFU.
import { describe, expect, it } from 'vitest';
import { desiredTracks, diffSubscriptions, parseMember, reduceRoom, roomTopic } from '@/lib/sfu/protocol';
import { enableOpusDtx } from '@/lib/sfu/peer';
import { countersFromStats, qualityFrom, worst } from '@/lib/sfu/quality';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const CH = '11111111-1111-4111-8111-111111111111';
const name = (s: string, r = 'abcdefghijkl') => `ch_${CH}.${s}.${r}`;
const meta = (user: string, session: string, joined: number, extra: Record<string, unknown> = {}) => ({
  user_id: user,
  session,
  joined_at: joined,
  at: joined,
  pub: 'sess1abcdef',
  tracks: [{ name: name('mic', session.padEnd(12, 'x')), source: 'mic' }],
  muted: false,
  deafened: false,
  quality: 'good',
  ...extra,
});

describe('состав комнаты', () => {
  it('темы Realtime совпадают с существующими правами доступа', () => {
    expect(roomTopic({ kind: 'channel', channelId: CH })).toBe(`typing:${CH}`);
    expect(roomTopic({ kind: 'dm', dmId: CH })).toBe(`dm:${CH}`);
  });

  it('свои записи не попадают в список; второе устройство вытесняет первое', () => {
    const state = { [A]: [meta(A, 'old', 100), meta(A, 'new', 200)], [B]: [meta(B, 'b', 150)] };
    const oldView = reduceRoom(state, { userId: A, session: 'old', joinedAt: 100 });
    expect(oldView.superseded).toBe(true);
    expect(oldView.others.map((o) => o.userId)).toEqual([B]);
    const newView = reduceRoom(state, { userId: A, session: 'new', joinedAt: 200 });
    expect(newView.superseded).toBe(false);
    const bView = reduceRoom(state, { userId: B, session: 'b', joinedAt: 150 });
    expect(bView.others).toHaveLength(1);
    expect(bView.others[0].session).toBe('new');
  });

  it('недоверенные данные presence отбрасываются', () => {
    expect(parseMember({ user_id: 'not-uuid', session: 'x' })).toBeNull();
    const m = parseMember({
      ...meta(A, 's', 1),
      tracks: [
        { name: 'evil; drop', source: 'mic' },
        { name: name('mic'), source: 'keylogger' },
        { name: name('screen'), source: 'screen' },
        { name: name('screen', 'zzzzzzzzzzzz'), source: 'screen' },
      ],
      quality: 'superb',
    });
    expect(m?.tracks).toEqual([{ name: name('screen'), source: 'screen' }]);
    expect(m?.quality).toBe('unknown');
    // без сессии публикации треки не учитываются
    expect(parseMember({ ...meta(A, 's', 1), pub: null })?.tracks).toEqual([]);
  });

  it('подписки: добавить новые, убрать исчезнувшие', () => {
    const others = reduceRoom({ [B]: [meta(B, 'b', 1, { tracks: [{ name: name('mic'), source: 'mic' }, { name: name('screen'), source: 'screen' }] })] }, { userId: A, session: 'a', joinedAt: 0 }).others;
    const want = desiredTracks(others);
    expect(want.map((w) => w.source)).toEqual(['mic', 'screen']);
    const d = diffSubscriptions([name('mic'), name('camera')], want);
    expect(d.add.map((x) => x.name)).toEqual([name('screen')]);
    expect(d.remove).toEqual([name('camera')]);
  });
});

describe('SDP', () => {
  it('Opus DTX включается один раз и не трогает остальное', () => {
    const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n';
    const out = enableOpusDtx(sdp);
    expect(out).toContain('a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1\r\n');
    expect(enableOpusDtx(out)).toBe(out);
    expect(enableOpusDtx('v=0\r\nm=video 9\r\n')).toBe('v=0\r\nm=video 9\r\n');
  });
});

describe('качество соединения', () => {
  it('по потерям и задержке', () => {
    const base = countersFromStats([{ type: 'inbound-rtp', packetsReceived: 1000, packetsLost: 0 }]);
    const good = countersFromStats([
      { type: 'inbound-rtp', packetsReceived: 2000, packetsLost: 0 },
      { type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.04 },
    ]);
    expect(qualityFrom(base, good, true)).toBe('excellent');
    const lossy = countersFromStats([{ type: 'inbound-rtp', packetsReceived: 1800, packetsLost: 200 }]);
    expect(qualityFrom(base, lossy, true)).toBe('poor');
    const slow = countersFromStats([{ type: 'remote-inbound-rtp', fractionLost: 0.03, roundTripTime: 0.25 }]);
    expect(qualityFrom(null, slow, true)).toBe('good');
    expect(qualityFrom(null, slow, false)).toBe('lost');
    expect(qualityFrom(null, countersFromStats([]), true)).toBe('unknown');
    expect(worst(['excellent', 'poor', 'unknown'])).toBe('poor');
  });
});
