import { BadgeCheck } from 'lucide-react';
import { useProfiles } from '@/stores/profiles';

// Золотая галочка и тег Owner рядом с ником. Значение badge задаётся только на сервере.
export function UserBadge({ userId, tag = true }: { userId: string | null | undefined; tag?: boolean }) {
  const badge = useProfiles((s) => (userId ? s.byId[userId]?.badge : undefined));
  if (badge !== 'owner') return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 self-center align-middle" title="Владелец Realism Voice">
      <BadgeCheck className="h-4 w-4 fill-amber-400 text-amber-950" aria-label="Подтверждённый владелец" />
      {tag && (
        <span className="rounded bg-gradient-to-r from-amber-300 to-yellow-500 px-1.5 text-[10px] font-bold leading-4 text-amber-950">Owner</span>
      )}
    </span>
  );
}
