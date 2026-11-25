// Глобальная подписка на изменения в базе (Supabase Realtime Postgres Changes).
// Сервер фильтрует события по RLS — клиент получает только то, что ему разрешено видеть.
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Category, Channel, DmConversation, Friendship, Member, Message, Profile, Server } from './types';
import { useAuth } from '@/stores/auth';
import { useServers } from '@/stores/servers';
import { useMessages } from '@/stores/messages';
import { useUnread } from '@/stores/unread';
import { useSocial, dmPeer } from '@/stores/social';
import { useProfiles } from '@/stores/profiles';
import { usePresence } from '@/stores/presence';
import { useUi } from '@/stores/ui';
import { useSettings } from '@/stores/settings';
import { useVoice } from '@/stores/voice';
import { useCalls } from '@/stores/calls';
import { handleIncomingMessage } from './incomingMessage';
import { sounds } from './sounds';
import { cleanupStaleUploads } from './media';
import { onBeforeSignOut } from '@/stores/auth';
import { useConnectivity } from '@/stores/connectivity';

let channel: RealtimeChannel | null = null;

// Перед выходом из аккаунта: уйти из голоса и снять присутствие, пока токен ещё действителен
onBeforeSignOut(async () => {
  await useVoice.getState().leave();
  await usePresence.getState().stop();
});

type Ev = 'INSERT' | 'UPDATE' | 'DELETE';

function rowOf<T>(p: RealtimePostgresChangesPayload<Record<string, unknown>>): Partial<T> {
  return (p.eventType === 'DELETE' ? p.old : p.new) as Partial<T>;
}

export { activeScopeId } from './incomingMessage';

function notify(title: string, body: string, onClick: () => void) {
  const prefs = useSettings.getState().prefs.notifications;
  if (prefs.flash) window.rv?.app.flashFrame();
  if (!prefs.desktop || document.hasFocus()) return;
  try {
    const n = new Notification(title, { body: body.slice(0, 180), silent: true });
    n.onclick = () => {
      window.rv?.app.focus();
      onClick();
    };
  } catch {
    /* уведомления недоступны */
  }
}

function handleMessageInsert(msg: Message) {
  handleIncomingMessage(msg, { notify, ring: useCalls.getState().ring });
}

export function startRealtime() {
  if (channel) return;
  const me = useAuth.getState().userId;
  const gen = ++channelGen;
  channel = supabase
    .channel('db-changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) =>
      handleMessageInsert(p.new as Message),
    )
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (p) =>
      useMessages.getState().applyRemote(p.new as Message),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'servers' }, (p) =>
      useServers.getState().applyServer(p.eventType as Ev, rowOf<Server>(p)),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'channels' }, (p) =>
      useServers.getState().applyChannel(p.eventType as Ev, rowOf<Channel>(p)),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, (p) =>
      useServers.getState().applyCategory(p.eventType as Ev, rowOf<Category>(p)),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'server_members' }, (p) =>
      useServers.getState().applyMember(p.eventType as Ev, rowOf<Member>(p)),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, (p) => {
      const row = rowOf<Friendship>(p);
      useSocial.getState().applyFriendship(p.eventType as Ev, row);
      if (p.eventType === 'INSERT' && row.addressee_id === me && useSettings.getState().prefs.notifications.friendRequests) {
        const from = useProfiles.getState().byId[row.requester_id!];
        sounds.message();
        notify('Заявка в друзья', `${from?.display_name ?? 'Пользователь'} хочет добавить вас в друзья`, () =>
          useUi.getState().setView({ kind: 'home', tab: 'pending' }),
        );
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_conversations' }, (p) =>
      useSocial.getState().applyDm(p.eventType as Ev, rowOf<DmConversation>(p)),
    )
    .on('postgres_changes', { event: '*', schema: 'public', table: 'blocks' }, (p) =>
      useSocial.getState().applyBlock(p.eventType as Ev, rowOf<{ blocker_id: string; blocked_id: string }>(p)),
    )
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (p) => {
      const prof = p.new as Profile;
      useProfiles.getState().upsert([prof]);
      if (prof.id === me) {
        useAuth.setState({ profile: prof });
        // Статус сменили на другом устройстве (например, «Невидимый») — применяем и здесь,
        // иначе это устройство продолжило бы показывать пользователя в сети
        if (prof.status) usePresence.getState().setStatus(prof.status);
      }
    })
    .subscribe((status) => {
      if (gen !== channelGen) return;
      if (status === 'SUBSCRIBED') {
        restartAttempt = 0;
        useConnectivity.getState().setDataJoined(true);
        // Повторная подписка после обрыва: события, пришедшие в это время, потеряны — догружаем
        if (everSubscribed) void resyncAfterReconnect();
        else void useUnread.getState().load();
        everSubscribed = true;
        return;
      }
      useConnectivity.getState().setDataJoined(false);
      // Канал закрыт сервером (истёк токен, сон, обрыв) — realtime-js сам его не вернёт: пересоздаём
      scheduleRestart();
    });
}

let everSubscribed = false;

/** После восстановления Realtime: непрочитанные, открытые переписки, серверы, друзья, статусы */
async function resyncAfterReconnect() {
  if (import.meta.env.DEV) console.debug('[realtime] resync after reconnect');
  await Promise.allSettled([
    useUnread.getState().load(),
    useMessages.getState().refreshLoaded(),
    useServers.getState().loadAll(),
    useSocial.getState().load(),
  ]);
  usePresence.getState().verify();
}

let channelGen = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let restartAttempt = 0;
function scheduleRestart() {
  if (restartTimer) return;
  const delay = [1000, 2000, 5000, 10000, 30000][Math.min(restartAttempt++, 4)];
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    if (!channel || !useAuth.getState().userId) return;
    const old = channel;
    channel = null;
    channelGen++; // события закрытия старого канала больше не учитываются
    await supabase.removeChannel(old).catch(() => undefined);
    startRealtime();
  }, delay);
}

export function stopRealtime() {
  channelGen++;
  everSubscribed = false;
  useConnectivity.getState().setDataJoined(false);
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  if (channel) void supabase.removeChannel(channel);
  channel = null;
}

/** Первичная загрузка данных после входа */
export async function bootstrap() {
  const auth = useAuth.getState();
  if (!auth.userId || !auth.profile) return;
  await Promise.allSettled([useServers.getState().loadAll(), useSocial.getState().load(), useUnread.getState().load()]);
  startRealtime();
  usePresence.getState().start(auth.userId, auth.profile.status);
  // Профили собеседников в ЛС
  const me = auth.userId;
  useProfiles.getState().ensure(useSocial.getState().dms.map((d) => dmPeer(d, me)));
  // Удаляем собственные брошенные загрузки (отменённые, прерванные) — бережём бесплатную квоту хранилища
  setTimeout(() => void cleanupStaleUploads(), 15_000);
}

export function teardown() {
  stopRealtime();
  void usePresence.getState().stop();
  void useVoice.getState().leave();
  useServers.getState().reset();
  useMessages.getState().reset();
  useUnread.getState().reset();
  useSocial.getState().reset();
}
