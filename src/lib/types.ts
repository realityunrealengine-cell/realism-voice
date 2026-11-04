export type ServerRole = 'member' | 'moderator' | 'admin' | 'owner';
export type ChannelType = 'text' | 'voice';
export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'invisible';
export type DmPrivacy = 'everyone' | 'friends';

export interface Profile {
  id: string;
  username: string;
  display_name: string;
  avatar_path: string | null;
  bio: string;
  custom_status: string;
  status: PresenceStatus;
  allow_dms: DmPrivacy;
  allow_friend_requests: boolean;
  accent_color: string | null;
  /** Значок задаётся только на сервере; поля нет, пока не применена миграция 0006 */
  badge?: 'owner' | null;
  /** Поля нет, пока не применена миграция 0007 */
  banner_path?: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface Server {
  id: string;
  name: string;
  description: string;
  icon_path: string | null;
  owner_id: string;
  members_can_invite: boolean;
  created_at: string;
}

export interface Member {
  server_id: string;
  user_id: string;
  role: ServerRole;
  nickname: string | null;
  joined_at: string;
}

export interface Category {
  id: string;
  server_id: string;
  name: string;
  position: number;
}

export interface Channel {
  id: string;
  server_id: string;
  category_id: string | null;
  name: string;
  type: ChannelType;
  topic: string;
  position: number;
  is_private: boolean;
  min_role: ServerRole;
  send_min_role: ServerRole;
  user_limit: number | null;
  slowmode_seconds: number;
  created_at: string;
}

export interface Attachment {
  path: string;
  name: string;
  size: number;
  mime: string;
  width?: number | null;
  height?: number | null;
}

export interface Message {
  id: string;
  channel_id: string | null;
  dm_id: string | null;
  author_id: string;
  kind: 'default' | 'call' | 'system';
  content: string;
  reply_to_id: string | null;
  attachments: Attachment[];
  mentions: string[];
  mention_everyone: boolean;
  reactions: Record<string, string[]>;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
  /** Только на клиенте */
  _status?: 'sending' | 'failed';
  _error?: string;
}

export interface DmConversation {
  id: string;
  user_low: string;
  user_high: string;
  created_at: string;
  last_message_at: string;
}

export interface Friendship {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: 'pending' | 'accepted';
  created_at: string;
  accepted_at: string | null;
}

export interface Invite {
  code: string;
  server_id: string;
  created_by: string | null;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  revoked: boolean;
  created_at: string;
}

export interface Ban {
  server_id: string;
  user_id: string;
  banned_by: string | null;
  reason: string;
  created_at: string;
}

export type Scope = { kind: 'channel'; id: string } | { kind: 'dm'; id: string };

export const ROLE_RANK: Record<ServerRole, number> = { member: 0, moderator: 1, admin: 2, owner: 3 };
export const ROLE_LABEL: Record<ServerRole, string> = {
  owner: 'Владелец',
  admin: 'Администратор',
  moderator: 'Модератор',
  member: 'Участник',
};
export const STATUS_LABEL: Record<PresenceStatus, string> = {
  online: 'В сети',
  idle: 'Не активен',
  dnd: 'Не беспокоить',
  invisible: 'Невидимый',
};

export function roleAtLeast(role: ServerRole | null | undefined, min: ServerRole): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[min];
}
