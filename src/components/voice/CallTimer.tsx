import { useEffect, useState } from 'react';
import { formatDuration } from '@/lib/format';
import { useVoice } from '@/stores/voice';

// Сколько вы находитесь в голосовом канале или звонке.
export function CallTimer({ className = '' }: { className?: string }) {
  const connectedAt = useVoice((s) => s.connectedAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (connectedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connectedAt]);

  if (connectedAt === null) return null;
  return (
    <span className={`tabular-nums ${className}`} title="Время в разговоре">
      {formatDuration(now - connectedAt)}
    </span>
  );
}
