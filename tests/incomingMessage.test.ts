import { afterEach, expect, it, vi } from 'vitest';
import { startRealtime, stopRealtime } from '@/lib/realtime';
import { sounds } from '@/lib/sounds';
import type { Channel, Message, Profile, Server } from '@/lib/types';
import { useAuth } from '@/stores/auth';
import { useCalls } from '@/stores/calls';
import { useMessages } from '@/stores/messages';
import { useProfiles } from '@/stores/profiles';
import { useServers } from '@/stores/servers';
import { DEFAULT_PREFS, useSettings } from '@/stores/settings';
import { useSocial } from '@/stores/social';
import { useUi } from '@/stores/ui';
import { useUnread } from '@/stores/unread';

const { channel, voice } = vi.hoisted(() => ({
  channel: vi.fn(), voice: { target: null as null | { kind: 'dm'; dmId: string } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: { channel, removeChannel: vi.fn() } }));
vi.mock('@/stores/voice', () => ({ useVoice: { getState: () => voice } }));

interface Input {
  room?: boolean;
  open?: boolean;
  focus?: boolean;
  settings?: boolean;
  voiceView?: boolean;
  blocked?: boolean;
  dms?: boolean;
  mode?: 'all' | 'mentions' | 'none';
  muted?: boolean;
  desktop?: boolean;
  mention?: 'me' | 'everyone';
  callAge?: number;
  inCall?: boolean;
  own?: boolean;
  deleted?: boolean;
  attachment?: boolean;
}
interface Effects {
  count?: 'read' | 'unread' | 'mention';
  sound?: 'message' | 'mention';
  flash?: boolean;
  body?: string;
  ring?: boolean;
}
const cases: [string, Input, Effects][] = [
  ['active DM', { open: true, focus: true }, { count: 'read' }],
  ['active server mention', { room: true, open: true, focus: true, mention: 'me' }, { count: 'read' }],
  ['DM in background window', { open: true }, { count: 'mention', sound: 'message', flash: true, body: 'Hello' }],
  ['settings cover focused DM', { open: true, focus: true, settings: true }, { count: 'mention', sound: 'message', flash: true }],
  ['voice view covers focused text channel', { room: true, open: true, focus: true, voiceView: true }, { count: 'unread', sound: 'message', flash: true }],
  ['DM attachment', { attachment: true }, { count: 'mention', sound: 'message', flash: true, body: 'Вложение' }],
  ['DM notifications disabled', { dms: false }, { count: 'mention' }],
  ['desktop disabled', { desktop: false }, { count: 'mention', sound: 'message', flash: true }],
  ['blocked DM', { blocked: true }, {}],
  ['channel in mentions mode', { room: true, mode: 'mentions' }, { count: 'unread' }],
  ['direct mention on muted server', { room: true, mode: 'mentions', mention: 'me', muted: true }, { count: 'mention', sound: 'mention', flash: true, body: 'Hello' }],
  ['everyone mention', { room: true, mode: 'mentions', mention: 'everyone' }, { count: 'mention', sound: 'mention', flash: true, body: 'Hello' }],
  ['muted channel without mention', { room: true, muted: true }, { count: 'unread' }],
  ['mentions with notifications off', { room: true, mode: 'none', mention: 'me' }, { count: 'mention' }],
  ['fresh call', { callAge: 59999, dms: false }, { count: 'mention', ring: true, flash: true, body: 'Входящий звонок' }],
  ['fresh call in active DM', { callAge: 0, open: true, focus: true }, { count: 'read', ring: true, flash: true }],
  ['call from blocked sender', { callAge: 0, blocked: true }, { ring: true, flash: true, body: 'Входящий звонок' }],
  ['call exactly one minute old', { callAge: 60000 }, { count: 'mention' }],
  ['already in this call', { callAge: 0, inCall: true }, { count: 'mention' }],
  ['own message', { own: true }, {}],
  ['deleted message', { deleted: true }, {}],
];

afterEach(() => {
  stopRealtime();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(cases)('%s', (_name, input, expected) => {
  const now = Date.UTC(2026, 0, 1);
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const scope = input.room ? 'channel' : 'dm';
  const prefs = { ...DEFAULT_PREFS.notifications, flash: true, desktop: input.desktop ?? true,
    dms: input.dms ?? true, serverMode: input.mode ?? 'all', mutedServers: input.muted ? ['server'] : [] };
  useSettings.setState({ prefs: { ...DEFAULT_PREFS, notifications: prefs } });
  useAuth.setState({ userId: 'me' });
  useSocial.setState({ blocked: input.blocked ? ['peer'] : [] });
  useProfiles.setState({ byId: { peer: { display_name: 'Peer' } as Profile } });
  useServers.setState({ channels: { server: [{ id: 'channel', server_id: 'server', name: 'chat' } as Channel] },
    servers: [{ id: 'server', name: 'Team' } as Server] });
  useUi.setState({ ...useUi.getInitialState(), settingsOpen: !!input.settings, voiceViewOpen: !!input.voiceView });
  if (input.open && input.room) useUi.setState({ view: { kind: 'server', serverId: 'server' }, lastChannel: { server: scope } });
  if (input.open && !input.room) useUi.setState({ view: { kind: 'dm', dmId: scope } });
  voice.target = input.inCall ? { kind: 'dm', dmId: scope } : null;

  const flash = vi.fn();
  const notices: { title: string; options: NotificationOptions; onclick?: () => void }[] = [];
  vi.stubGlobal('document', { hasFocus: () => !!input.focus });
  vi.stubGlobal('window', { rv: { app: { flashFrame: flash, focus: vi.fn() } } });
  vi.stubGlobal('Notification', class {
    constructor(public title: string, public options: NotificationOptions) { notices.push(this); }
  });
  const messageSound = vi.spyOn(sounds, 'message').mockImplementation(() => {});
  const mentionSound = vi.spyOn(sounds, 'mention').mockImplementation(() => {});
  const ring = vi.spyOn(useCalls.getState(), 'ring').mockImplementation(() => {});
  const apply = vi.spyOn(useMessages.getState(), 'applyRemote').mockImplementation(() => {});
  const read = vi.spyOn(useUnread.getState(), 'markRead').mockImplementation(() => {});
  const bump = vi.spyOn(useUnread.getState(), 'bump').mockImplementation(() => {});

  const db = { on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() };
  channel.mockReturnValue(db);
  startRealtime();
  const insert = db.on.mock.calls.find(([, f]) => f.table === 'messages' && f.event === 'INSERT')![2];
  const msg: Message = {
    id: 'message', author_id: input.own ? 'me' : 'peer', channel_id: input.room ? scope : null,
    dm_id: input.room ? null : scope, kind: input.callAge === undefined ? 'default' : 'call',
    created_at: new Date(now - (input.callAge ?? 0)).toISOString(), content: input.attachment ? '' : 'Hello',
    mentions: input.mention === 'me' ? ['me'] : [], mention_everyone: input.mention === 'everyone',
    deleted_at: input.deleted ? new Date(now).toISOString() : null, reply_to_id: null, edited_at: null, attachments: [], reactions: {},
  };
  insert({ new: msg });

  expect(apply.mock.calls).toEqual([[msg]]);
  expect(read.mock.calls).toEqual(expected.count === 'read' ? [[scope]] : []);
  const increment = expected.count === 'unread' || expected.count === 'mention';
  expect(bump.mock.calls).toEqual(increment ? [[scope, input.room ? 'server' : null, expected.count === 'mention']] : []);
  expect(messageSound).toHaveBeenCalledTimes(Number(expected.sound === 'message'));
  expect(mentionSound).toHaveBeenCalledTimes(Number(expected.sound === 'mention'));
  expect(ring.mock.calls).toEqual(expected.ring ? [[{ dmId: scope, from: 'peer' }]] : []);
  expect(flash).toHaveBeenCalledTimes(expected.flash ? 1 : 0);
  expect(notices).toHaveLength(expected.body ? 1 : 0);
  if (expected.body) {
    expect(notices[0]).toMatchObject({ title: input.room ? 'Peer • #chat (Team)' : 'Peer', options: { body: expected.body, silent: true } });
    notices[0].onclick!();
    expect(useUi.getState().view).toEqual(input.room ? { kind: 'server', serverId: 'server' } : { kind: 'dm', dmId: scope });
    if (input.room) expect(useUi.getState().lastChannel.server).toBe(scope);
  }
});
