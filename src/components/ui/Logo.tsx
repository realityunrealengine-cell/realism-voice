// Фирменный знак Realism Voice: волна голоса внутри скруглённого кристалла.
export function LogoMark({ size = 40, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id="rv-g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--a1, #5b7cfa)" />
          <stop offset="1" stopColor="var(--a2, #a855f7)" />
        </linearGradient>
        <linearGradient id="rv-g2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="18" fill="url(#rv-g1)" />
      <rect x="4" y="4" width="56" height="28" rx="18" fill="url(#rv-g2)" />
      <g fill="#fff">
        <rect x="15" y="27" width="5" height="10" rx="2.5" opacity="0.85" />
        <rect x="23.5" y="20" width="5" height="24" rx="2.5" />
        <rect x="32" y="14" width="5" height="36" rx="2.5" />
        <rect x="40.5" y="22" width="5" height="20" rx="2.5" />
        <rect x="49" y="28" width="4" height="8" rx="2" opacity="0.85" />
      </g>
    </svg>
  );
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-3">
      <LogoMark size={44} />
      <div className="leading-tight">
        <div className="text-xl font-bold tracking-tight text-white">
          Realism <span className="accent-text">Voice</span>
        </div>
        <div className="text-xs text-slate-400">Голос без границ</div>
      </div>
    </div>
  );
}
