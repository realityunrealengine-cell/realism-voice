import type { ReactNode } from 'react';

export function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-white/5 py-4">
      <div>
        <div className="text-sm font-medium text-white">{title}</div>
        {desc && <div className="mt-0.5 text-xs text-slate-400">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`glass rounded-2xl p-5 ${className}`}>{children}</div>;
}
