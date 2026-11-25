// Связь P2P-хаба с приложением: когда и с кем держать прямые каналы, куда показывать сообщения.
//
// Хаб работает, если выбран режим доставки сообщений Auto или «Только P2P» (или в очереди ещё есть
// неотправленные P2P-операции). Каналы открываются только к собеседникам, которые сейчас в сети,
// и только пока сам пользователь не «Невидимый» (иначе присутствие в канале выдало бы его).
import type { Message } from '@/lib/types';
import { voiceRealtime } from '@/lib/sfu/realtime';
import { P2pHub, ACK_TIMEOUT_MS, type SendOutcome } from './hub';
import { p2pStore, toMessage } from './store';
import { useAuth } from '@/stores/auth';
import { useSettings } from '@/stores/settings';
import { usePresence } from '@/stores/presence';
import { useSocial, dmPeer } from '@/stores/social';
import { useNetStats } from '@/stores/netStats';

/** Сколько переписок держать на прямой связи одновременно (каждая — отдельное соединение) */
export const MAX_ROOMS = 12;

/** STUN для сообщений; TURN не используется — при недоступности прямого пути работает сервер */
export const MESSAGE_ICE: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];

let hub: P2pHub | null = null;
let incoming: ((m: Message) => void) | null = null;
let applyUi: ((m: Message) => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let unsubs: (() => void)[] = [];
let pendingOps = 0;

const log = (m: string) => {
  if (import.meta.env.DEV) console.debug('[p2p]', m);
};

function mode() {
  return useSettings.getState().prefs.messageMode;
}

/** Прямые P2P-сообщения возможны при текущих настройках */
export function p2pMessagesEnabled(): boolean {
  const p = useSettings.getState().prefs;
  // «Не раскрывать IP» требует TURN, а для сообщений TURN не используется — тогда только сервер
  return p.messageMode !== 'server' && !p.p2pRelayOnly;
}

function wanted(): boolean {
  if (!useAuth.getState().userId) return false;
  return p2pMessagesEnabled() || pendingOps > 0;
}

function rooms() {
  const me = useAuth.getState().userId;
  const pres = usePresence.getState();
  if (!me || pres.self === 'invisible' || !pres.connected) return [];
  const social = useSocial.getState();
  return [...social.dms]
    .map((d) => ({ dm: d.id, peer: dmPeer(d, me), at: d.last_message_at }))
    .filter((d) => d.peer !== me && !!pres.online[d.peer] && !social.blocked.includes(d.peer))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MAX_ROOMS)
    .map(({ dm, peer }) => ({ dm, peer }));
}

function apply() {
  timer = null;
  const me = useAuth.getState().userId;
  if (!wanted() || !me) {
    if (hub) {
      void hub.stop();
      hub = null;
      useNetStats.setState({ links: Object.fromEntries(Object.entries(useNetStats.getState().links).filter(([k]) => !k.startsWith('msg:'))) });
    }
    return;
  }
  if (hub && hub.me !== me) {
    void hub.stop();
    hub = null;
  }
  hub ??= new P2pHub({
    me,
    store: p2pStore(),
    rt: () => voiceRealtime(),
    iceServers: MESSAGE_ICE,
    log,
    onMessage: (m, fresh) => {
      if (fresh && m.author_id !== me) incoming?.(m);
      else applyUi?.(m);
    },
    onBytes: (s, r) => useNetStats.getState().add('p2pMsg', s, r),
    onLinks: (links) => {
      const rest = Object.fromEntries(Object.entries(useNetStats.getState().links).filter(([k]) => !k.startsWith('msg:')));
      useNetStats.setState({ links: { ...rest, ...links } });
    },
  });
  hub.setRooms(rooms());
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    // Очередь могла опустеть: тогда в режиме «Только сервер» хаб больше не нужен
    void p2p.refreshPending().then(apply, apply);
  }, 800);
}

export const p2p = {
  /** Запуск после входа: отслеживание статусов, переписок и настроек */
  start(handlers: { incoming: (m: Message) => void; apply: (m: Message) => void }) {
    incoming = handlers.incoming;
    applyUi = handlers.apply;
    if (unsubs.length) return;
    unsubs = [
      usePresence.subscribe((s, prev) => {
        if (s.online !== prev.online || s.self !== prev.self || s.connected !== prev.connected) schedule();
      }),
      useSocial.subscribe((s, prev) => {
        if (s.dms !== prev.dms || s.blocked !== prev.blocked) schedule();
      }),
      useSettings.subscribe((s, prev) => {
        if (s.prefs.messageMode !== prev.prefs.messageMode || s.prefs.p2pRelayOnly !== prev.prefs.p2pRelayOnly) schedule();
      }),
    ];
    void this.refreshPending().then(schedule);
  },

  async stop() {
    for (const u of unsubs) u();
    unsubs = [];
    if (timer) clearTimeout(timer);
    timer = null;
    const h = hub;
    hub = null;
    await h?.stop();
  },

  async refreshPending(): Promise<number> {
    const me = useAuth.getState().userId;
    pendingOps = me ? (await p2pStore().outbox(me)).length : 0;
    return pendingOps;
  },

  reachable(dm: string): boolean {
    return !!hub && hub.reachable(dm);
  },

  /** Отправка через P2P по режиму; 'server' — отправлять обычным путём */
  async send(dm: string, msg: { id: string; content: string; reply_to_id: string | null; created_at: string }): Promise<SendOutcome | 'server'> {
    const m = mode();
    if (!p2pMessagesEnabled()) return 'server';
    const peer = peerOf(dm);
    if (!peer) return 'server';
    if (!hub) apply();
    if (!hub) return 'server';
    if (m === 'auto') return hub.sendMessage(dm, peer, msg, ACK_TIMEOUT_MS);
    pendingOps++;
    return hub.sendMessage(dm, peer, msg, null);
  },

  async edit(dm: string, id: string, content: string) {
    const peer = peerOf(dm);
    if (!peer) throw new Error('Переписка не найдена');
    await ensureHub().edit(dm, peer, id, content);
  },

  async remove(dm: string, id: string) {
    const peer = peerOf(dm);
    if (!peer) throw new Error('Переписка не найдена');
    await ensureHub().remove(dm, peer, id);
  },

  async react(dm: string, id: string, emoji: string, add: boolean) {
    const peer = peerOf(dm);
    if (!peer) throw new Error('Переписка не найдена');
    await ensureHub().react(dm, peer, id, emoji, add);
  },

  /** Локальная P2P-история переписки (видна и после переключения на «Только сервер») */
  async history(dm: string): Promise<Message[]> {
    const me = useAuth.getState().userId;
    if (!me) return [];
    try {
      return (await p2pStore().messagesFor(me, dm)).map(toMessage);
    } catch {
      return [];
    }
  },

  onConnectivityRestored() {
    hub?.onConnectivityRestored();
    schedule();
  },

  refreshLinkInfo() {
    return hub?.refreshLinkInfo();
  },

  get running(): boolean {
    return !!hub;
  },
};

function peerOf(dm: string): string | null {
  const me = useAuth.getState().userId;
  const d = useSocial.getState().dms.find((x) => x.id === dm);
  return me && d ? dmPeer(d, me) : null;
}

/** Правки и удаления P2P-сообщений идут через очередь, даже если сейчас выбран «Только сервер» */
function ensureHub(): P2pHub {
  pendingOps++;
  if (!hub) apply();
  if (!hub) throw new Error('Войдите в аккаунт');
  return hub;
}
