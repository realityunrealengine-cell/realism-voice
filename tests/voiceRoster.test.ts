import { describe, expect, it } from 'vitest';
import { channelRoster, reduceVoicePresence, serverRoster, type LiveParticipant } from '@/lib/voiceRoster';
import { reduceOnline } from '@/lib/onlineStatus';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const CH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CH2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const meta = (user: string, channel = CH, extra: Record<string, unknown> = {}) => ({ user_id: user, channel_id: channel, joined_at: 1, at: 1, ...extra });
const live = (identity: string, joinedAt: number, extra: Partial<LiveParticipant> = {}): LiveParticipant => ({
  identity, micMuted: false, camera: false, screen: false, joinedAt, ...extra,
});

describe('голосовой канал: «3 в канале», а слева 2', () => {
  it('воспроизведение: presence потерял третьего, LiveKit видит троих — список подключённого пользователя берётся из LiveKit', () => {
    // Presence-состояние у клиента замерло: в нём только двое
    const presence = reduceVoicePresence({ [U1]: [meta(U1)], [U2]: [meta(U2)] });
    expect(presence).toHaveLength(2);
    // В комнате LiveKit трое — это и показывает счётчик «3 в канале»
    const participants = [live(U1, 10), live(U2, 20), live(U3, 30)];
    const roster = channelRoster(CH, presence, participants);
    expect(roster.map((m) => m.user_id)).toEqual([U1, U2, U3]);
    expect(roster).toHaveLength(participants.length); // счётчик и список совпадают
  });

  it('флаги «без звука» берутся из presence, а состав — из LiveKit', () => {
    const presence = reduceVoicePresence({ [U2]: [meta(U2, CH, { deafened: true, muted: true })] });
    const roster = channelRoster(CH, presence, [live(U1, 1), live(U2, 2)]);
    expect(roster.find((m) => m.user_id === U2)).toMatchObject({ deafened: true, muted: true });
    expect(roster.find((m) => m.user_id === U1)).toMatchObject({ deafened: false, muted: false });
  });

  it('статус «В сети»/«Невидимый» не влияет на состав голосового канала', () => {
    // Невидимка не публикует presence:global, но в голосовом presence присутствует
    const online = reduceOnline({ [U1]: [{ user_id: U1, status: 'online', at: 1 }] });
    expect(online[U3]).toBeUndefined();
    const presence = reduceVoicePresence({ [U1]: [meta(U1)], [U3]: [meta(U3)] });
    expect(channelRoster(CH, presence, null).map((m) => m.user_id)).toEqual([U1, U3]);
  });

  it('у всех клиентов одинаковый порядок — по времени входа', () => {
    const a = reduceVoicePresence({ [U3]: [meta(U3, CH, { joined_at: 5 })], [U1]: [meta(U1, CH, { joined_at: 9 })], [U2]: [meta(U2, CH, { joined_at: 7 })] });
    const b = reduceVoicePresence({ [U2]: [meta(U2, CH, { joined_at: 7 })], [U1]: [meta(U1, CH, { joined_at: 9 })], [U3]: [meta(U3, CH, { joined_at: 5 })] });
    expect(a.map((m) => m.user_id)).toEqual([U3, U2, U1]);
    expect(b.map((m) => m.user_id)).toEqual(a.map((m) => m.user_id));
  });

  it('несколько устройств одного пользователя — одна запись (самая свежая)', () => {
    const list = reduceVoicePresence({ [U1]: [meta(U1, CH2, { at: 1 }), meta(U1, CH, { at: 5 })] });
    expect(list).toHaveLength(1);
    expect(list[0].channel_id).toBe(CH);
  });

  it('мусорные записи presence игнорируются (identity ↔ id Supabase)', () => {
    const list = reduceVoicePresence({ x: [{ user_id: 'not-a-uuid', channel_id: CH }, { user_id: U1, channel_id: 'bad' }, meta(U2)] });
    expect(list.map((m) => m.user_id)).toEqual([U2]);
  });

  it('устаревшая запись presence в другом канале не дублирует участника комнаты', () => {
    const presence = reduceVoicePresence({ [U2]: [meta(U2, CH2)], [U1]: [meta(U1, CH)] });
    const all = serverRoster(presence, CH, [live(U1, 1), live(U2, 2)]);
    expect(all.filter((m) => m.user_id === U2)).toHaveLength(1);
    expect(all.find((m) => m.user_id === U2)?.channel_id).toBe(CH);
  });
});

describe('онлайн-статусы', () => {
  it('невидимки и мусор не попадают в список', () => {
    const online = reduceOnline({
      [U1]: [{ user_id: U1, status: 'invisible', at: 2 }],
      [U2]: [{ user_id: U2, status: 'dnd', at: 1 }],
      bad: [{ user_id: 'x', status: 'online' }],
    });
    expect(online).toEqual({ [U2]: 'dnd' });
  });

  it('несколько устройств: побеждает последний установленный статус', () => {
    const online = reduceOnline({ [U1]: [{ user_id: U1, status: 'online', at: 1 }, { user_id: U1, status: 'idle', at: 9 }] });
    expect(online[U1]).toBe('idle');
  });
});
