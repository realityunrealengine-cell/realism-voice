import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useUi } from '@/stores/ui';
import { useServers } from '@/stores/servers';
import { usePresence } from '@/stores/presence';
import { useVoice } from '@/stores/voice';
import { useUnread } from '@/stores/unread';
import { useSettings } from '@/stores/settings';
import { ServerRail } from './ServerRail';
import { ChannelSidebar } from './ChannelSidebar';
import { HomeSidebar } from './HomeSidebar';
import { MemberList } from './MemberList';
import { UserPanel } from './UserPanel';
import { ChatView } from '@/components/chat/ChatView';
import { FriendsView } from '@/components/friends/FriendsView';
import { VoiceView } from '@/components/voice/VoiceView';
import { SettingsView } from '@/components/settings/SettingsView';
import { Modals } from '@/components/modals/Modals';
import { IncomingCall } from '@/components/voice/IncomingCall';
import { EmptyState } from '@/components/ui/primitives';
import { Hash } from 'lucide-react';

function useGlobalHotkeys() {
  useEffect(() => {
    const offHotkey = window.rv?.app.onHotkey((action) => {
      const v = useVoice.getState();
      if (v.status !== 'connected') return;
      if (action === 'toggleMute') v.toggleMute();
      else v.toggleDeafen();
    });
    const offPtt = window.rv?.ptt.onState((pressed) => useVoice.getState().setPtt(pressed));

    // PTT в активном окне (работает и без глобального перехвата)
    const matches = (code: string) => {
      const p = useSettings.getState().prefs;
      return p.voiceMode === 'ptt' && p.pttBinding.code === code && useVoice.getState().status === 'connected';
    };
    const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (!e.repeat && matches(e.code) && !isTyping(e.target)) useVoice.getState().setPtt(true);
    };
    const up = (e: KeyboardEvent) => {
      if (matches(e.code)) useVoice.getState().setPtt(false);
    };
    const mdown = (e: MouseEvent) => e.button >= 2 && matches(`Mouse${e.button + 1}`) && useVoice.getState().setPtt(true);
    const mup = (e: MouseEvent) => e.button >= 2 && matches(`Mouse${e.button + 1}`) && useVoice.getState().setPtt(false);
    const blur = () => {
      // Если глобального перехвата нет — отпускаем PTT при потере фокуса
      void window.rv?.ptt.isGlobalAvailable().then((g) => !g && useVoice.getState().setPtt(false));
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('mousedown', mdown);
    window.addEventListener('mouseup', mup);
    window.addEventListener('blur', blur);
    return () => {
      offHotkey?.();
      offPtt?.();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('mousedown', mdown);
      window.removeEventListener('mouseup', mup);
      window.removeEventListener('blur', blur);
    };
  }, []);
}

function useBadge() {
  const counts = useUnread((s) => s.counts);
  useEffect(() => {
    const total = Object.values(counts).reduce((a, c) => a + c.mentions, 0);
    window.rv?.app.setBadge(total);
  }, [counts]);
}

export function AppShell() {
  const view = useUi((s) => s.view);
  const voiceViewOpen = useUi((s) => s.voiceViewOpen);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const memberListOpen = useUi((s) => s.memberListOpen);
  const lastChannel = useUi((s) => s.lastChannel);
  const channels = useServers((s) => (view.kind === 'server' ? s.channels[view.serverId] : undefined));
  const servers = useServers((s) => s.servers);
  const voiceTarget = useVoice((s) => s.target);
  const loaded = useServers((s) => s.loaded);
  useGlobalHotkeys();
  useBadge();

  // Сервер удалён/мы вышли — возвращаемся домой
  useEffect(() => {
    if (loaded && view.kind === 'server' && !servers.some((s) => s.id === view.serverId)) {
      useUi.getState().setView({ kind: 'home', tab: 'online' });
    }
  }, [loaded, servers, view]);

  // Presence голосовых каналов: открытый сервер + сервер текущего подключения
  useEffect(() => {
    const ids: string[] = [];
    if (view.kind === 'server') ids.push(view.serverId);
    if (voiceTarget?.kind === 'channel') ids.push(voiceTarget.serverId);
    usePresence.getState().watchVoice(ids);
  }, [view, voiceTarget]);

  let center: JSX.Element;
  if (view.kind === 'home') center = <FriendsView />;
  else if (view.kind === 'dm') center = voiceViewOpen ? <VoiceView /> : <ChatView scope={{ kind: 'dm', id: view.dmId }} />;
  else {
    const textChannels = (channels ?? []).filter((c) => c.type === 'text');
    const chId = lastChannel[view.serverId];
    const ch = textChannels.find((c) => c.id === chId) ?? textChannels[0];
    if (voiceViewOpen) center = <VoiceView />;
    else if (ch) center = <ChatView scope={{ kind: 'channel', id: ch.id }} key={ch.id} />;
    else center = <EmptyState icon={<Hash className="h-7 w-7" />} title="Нет текстовых каналов" body="Создайте канал, чтобы начать общение." />;
  }

  return (
    <div className="flex h-full min-h-0">
      <ServerRail />
      <div className="glass flex w-[264px] shrink-0 flex-col border-y-0 border-l-0">
        <div className="min-h-0 flex-1">{view.kind === 'server' ? <ChannelSidebar serverId={view.serverId} /> : <HomeSidebar />}</div>
        <UserPanel />
      </div>
      <main className="flex min-w-0 flex-1 flex-col bg-base-900/40">{center}</main>
      <AnimatePresence initial={false}>
        {view.kind === 'server' && memberListOpen && !voiceViewOpen && (
          <motion.aside
            key="members"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 248, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="glass shrink-0 overflow-hidden border-y-0 border-r-0"
          >
            <MemberList serverId={view.serverId} />
          </motion.aside>
        )}
      </AnimatePresence>
      <AnimatePresence>{settingsOpen && <SettingsView key="settings" />}</AnimatePresence>
      <Modals />
      <IncomingCall />
    </div>
  );
}
