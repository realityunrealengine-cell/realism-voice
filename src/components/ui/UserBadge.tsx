import { BadgeCheck } from 'lucide-react';
import { useProfiles } from '@/stores/profiles';

const OWNER = {
  title: 'Владелец Realism Voice',
  label: 'Подтверждённый владелец',
  check: 'fill-amber-400 text-amber-950',
  tag: 'Owner',
  tagClass: 'from-amber-300 to-yellow-500 text-amber-950',
};

const TESTER = {
  title: 'Официальный тестировщик Realism Voice',
  label: 'Подтверждённый тестировщик',
  check: 'fill-slate-300 text-slate-800',
  tag: 'TESTER',
  tagClass: 'from-slate-200 to-slate-400 text-slate-800',
};

// Галочка и тег рядом с ником: Owner — золотые, Tester — серебряные. Значение badge задаётся только на сервере.
export function UserBadge({ userId, tag = true }: { userId: string | null | undefined; tag?: boolean }) {
  const badge = useProfiles((s) => (userId ? s.byId[userId]?.badge : undefined));
  const style = badge === 'owner' ? OWNER : badge === 'tester' ? TESTER : null;
  if (!style) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 self-center align-middle" title={style.title}>
      <BadgeCheck className={`h-4 w-4 ${style.check}`} aria-label={style.label} />
      {tag && <span className={`rounded bg-gradient-to-r px-1.5 text-[10px] font-bold leading-4 ${style.tagClass}`}>{style.tag}</span>}
    </span>
  );
}
