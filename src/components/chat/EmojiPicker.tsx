import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { EMOJI_GROUPS } from '@/lib/emoji';

export function EmojiPicker({ onPick, onClose, className = '' }: { onPick: (e: string) => void; onClose: () => void; className?: string }) {
  const [group, setGroup] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => window.addEventListener('mousedown', down), 0);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className={`glass-strong z-40 w-[340px] rounded-2xl p-2 shadow-glass ${className}`}
    >
      <div className="mb-2 flex gap-1 border-b border-white/5 pb-2">
        {EMOJI_GROUPS.map((g, i) => (
          <button
            key={g.title}
            title={g.title}
            onClick={() => setGroup(i)}
            className={`flex h-8 w-8 items-center justify-center rounded-lg text-lg transition ${i === group ? 'bg-white/15' : 'hover:bg-white/10'}`}
          >
            {g.icon}
          </button>
        ))}
      </div>
      <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{EMOJI_GROUPS[group].title}</div>
      <div className="grid max-h-[240px] grid-cols-8 gap-0.5 overflow-y-auto">
        {EMOJI_GROUPS[group].emojis.map((e) => (
          <button key={e} onClick={() => onPick(e)} className="flex h-9 w-9 items-center justify-center rounded-lg text-[22px] transition hover:scale-110 hover:bg-white/10">
            {e}
          </button>
        ))}
      </div>
    </motion.div>
  );
}
