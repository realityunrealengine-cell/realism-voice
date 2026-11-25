// Каким путём идут медиа звонка. Значение берётся из getStats() выбранной пары ICE-кандидатов:
// «P2P» показывается только при настоящем прямом соединении, TURN — как «Relay», Cloudflare SFU — «Сервер».
import { ArrowLeftRight, Repeat2, Server, Loader2 } from 'lucide-react';
import { useVoice } from '@/stores/voice';
import type { CallTransport } from '@/lib/sfu/call';

export const TRANSPORT_UI: Record<CallTransport, { label: string; hint: string; cls: string; Icon: typeof Server }> = {
  p2p: {
    label: 'P2P',
    hint: 'Напрямую между компьютерами — медиа не проходят через серверы',
    cls: 'bg-emerald-500/15 text-emerald-300',
    Icon: ArrowLeftRight,
  },
  relay: {
    label: 'Relay',
    hint: 'Через TURN-ретранслятор: прямой путь недоступен (NAT/CGNAT/брандмауэр) или скрыт IP',
    cls: 'bg-amber-500/15 text-amber-200',
    Icon: Repeat2,
  },
  sfu: {
    label: 'Сервер',
    hint: 'Через сервер Cloudflare Realtime (SFU)',
    cls: 'bg-sky-500/15 text-sky-200',
    Icon: Server,
  },
  pending: {
    label: 'P2P…',
    hint: 'Устанавливается прямое соединение',
    cls: 'bg-white/10 text-slate-300',
    Icon: Loader2,
  },
};

export function TransportBadge({ className = '' }: { className?: string }) {
  const t = useVoice((s) => s.transport);
  const status = useVoice((s) => s.status);
  if (!t || (status !== 'connected' && status !== 'reconnecting')) return null;
  const ui = TRANSPORT_UI[t];
  return (
    <span title={ui.hint} className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${ui.cls} ${className}`}>
      <ui.Icon className={`h-3 w-3 ${t === 'pending' ? 'animate-spin' : ''}`} />
      {ui.label}
    </span>
  );
}
