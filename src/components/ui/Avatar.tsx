import { colorFromId, initials } from '@/lib/format';
import { publicUrl } from '@/lib/supabase';
import { useProfile } from '@/stores/profiles';
import { displayStatus, usePresence } from '@/stores/presence';
import type { PresenceStatus } from '@/lib/types';

const STATUS_COLOR: Record<PresenceStatus | 'offline', string> = {
  online: 'bg-emerald-400',
  idle: 'bg-amber-400',
  dnd: 'bg-rose-500',
  invisible: 'bg-slate-500',
  offline: 'bg-slate-500',
};

export function StatusDot({ status, className = '' }: { status: PresenceStatus | 'offline'; className?: string }) {
  return <span className={`block rounded-full ring-[3px] ring-base-900 ${STATUS_COLOR[status]} ${className}`} />;
}

interface AvatarProps {
  userId: string | null | undefined;
  size?: number;
  showStatus?: boolean;
  speaking?: boolean;
  className?: string;
}

export function Avatar({ userId, size = 40, showStatus = false, speaking = false, className = '' }: AvatarProps) {
  const profile = useProfile(userId);
  const status = usePresence((s) => (userId ? displayStatus(s, userId) : 'offline'));
  const url = publicUrl('avatars', profile?.avatar_path);
  const name = profile?.display_name ?? '?';
  const dot = Math.max(10, Math.round(size * 0.3));
  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
      <div
        className={`h-full w-full overflow-hidden rounded-full transition-shadow ${speaking ? 'speaking-ring' : ''}`}
        style={{ background: url ? undefined : colorFromId(userId ?? 'x') }}
      >
        {url ? (
          <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center font-semibold text-white"
            style={{ fontSize: size * 0.38 }}
          >
            {initials(name)}
          </div>
        )}
      </div>
      {showStatus && (
        <span className="absolute -bottom-0.5 -right-0.5" style={{ width: dot, height: dot }}>
          <StatusDot status={status} className="h-full w-full" />
        </span>
      )}
    </div>
  );
}

export function ServerIcon({ name, iconPath, size = 48, id }: { name: string; iconPath: string | null; size?: number; id: string }) {
  const url = publicUrl('server-icons', iconPath);
  if (url) return <img src={url} alt="" className="h-full w-full object-cover" style={{ width: size, height: size }} draggable={false} />;
  return (
    <div
      className="flex h-full w-full items-center justify-center font-semibold text-white"
      style={{ width: size, height: size, background: `linear-gradient(135deg, ${colorFromId(id)}, ${colorFromId(id + 'x')})`, fontSize: size * 0.34 }}
    >
      {initials(name)}
    </div>
  );
}
