import type { Message } from './types';
import { sounds } from './sounds';
import { useAuth } from '@/stores/auth';
import type { IncomingCall } from '@/stores/calls';
import { useMessages } from '@/stores/messages';
import { useProfiles } from '@/stores/profiles';
import { useServers } from '@/stores/servers';
import { useSettings } from '@/stores/settings';
import { useSocial } from '@/stores/social';
import { useUi } from '@/stores/ui';
import { useUnread } from '@/stores/unread';
import { useVoice } from '@/stores/voice';

interface MessageAlerts {
  notify: (title: string, body: string, onClick: () => void) => void;
  ring: (call: Pick<IncomingCall, 'dmId' | 'from'>) => void;
}

export function activeScopeId(): string | null {
  const ui = useUi.getState();
  if (ui.settingsOpen) return null;
  if (ui.view.kind === 'dm') return ui.view.dmId;
  if (ui.view.kind === 'server' && !ui.voiceViewOpen) return ui.lastChannel[ui.view.serverId] ?? null;
  return null;
}

export function handleIncomingMessage(msg: Message, { notify, ring }: MessageAlerts) {
  const me = useAuth.getState().userId;
  useMessages.getState().applyRemote(msg);
  if (!me || msg.author_id === me || msg.deleted_at) return;

  const scopeId = (msg.channel_id ?? msg.dm_id)!;
  const isActive = activeScopeId() === scopeId && document.hasFocus();
  const author = useProfiles.getState().byId[msg.author_id];
  const authorName = author?.display_name ?? 'Новое сообщение';

  if (msg.kind === 'call' && msg.dm_id) {
    if (Date.now() - new Date(msg.created_at).getTime() < 60_000) {
      const v = useVoice.getState();
      const inThisCall = v.target?.kind === 'dm' && v.target.dmId === msg.dm_id;
      if (!inThisCall) {
        ring({ dmId: msg.dm_id, from: msg.author_id });
        notify(authorName, 'Входящий звонок', () => useUi.getState().setView({ kind: 'dm', dmId: msg.dm_id! }));
      }
    }
  }

  if (isActive) {
    useUnread.getState().markRead(scopeId);
    return;
  }

  const prefs = useSettings.getState().prefs.notifications;
  if (msg.dm_id) {
    if (useSocial.getState().blocked.includes(msg.author_id)) return;
    useUnread.getState().bump(scopeId, null, true);
    if (prefs.dms && msg.kind === 'default') {
      sounds.message();
      notify(authorName, msg.content || 'Вложение', () => useUi.getState().setView({ kind: 'dm', dmId: msg.dm_id! }));
    }
    return;
  }

  const ch = Object.values(useServers.getState().channels).flat().find((c) => c.id === msg.channel_id);
  if (!ch) return;
  const mentioned = msg.mentions.includes(me) || msg.mention_everyone;
  useUnread.getState().bump(scopeId, ch.server_id, mentioned);
  const muted = prefs.mutedServers.includes(ch.server_id);
  const should = !muted && (prefs.serverMode === 'all' || (prefs.serverMode === 'mentions' && mentioned));
  if (should || (mentioned && prefs.serverMode !== 'none')) {
    mentioned ? sounds.mention() : sounds.message();
    const server = useServers.getState().servers.find((s) => s.id === ch.server_id);
    notify(`${authorName} • #${ch.name}${server ? ` (${server.name})` : ''}`, msg.content || 'Вложение', () =>
      useUi.getState().openChannel(ch.server_id, ch.id),
    );
  }
}
