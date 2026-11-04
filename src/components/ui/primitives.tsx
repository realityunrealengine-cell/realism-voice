import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return <Loader2 className={`animate-spin ${className}`} />;
}

export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? 'accent-bg' : 'bg-white/15'}`}
    >
      {/* Только CSS: `layout` из framer-motion внутри AnimatePresence мешает завершению exit-анимации родителя */}
      <span className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left] duration-150" style={{ left: checked ? 22 : 2 }} />
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  className = '',
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} className={`input cursor-pointer appearance-none ${className}`}>
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-base-900">
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full"
        style={{ background: `linear-gradient(90deg, var(--a1) 0%, var(--a2) ${pct}%, rgba(255,255,255,0.12) ${pct}%)` }}
      />
      {format && <span className="w-14 shrink-0 text-right text-xs tabular-nums text-slate-400">{format(value)}</span>}
    </div>
  );
}

export function ModalShell({
  open,
  onClose,
  children,
  width = 'max-w-md',
  title,
  subtitle,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            className={`glass-strong relative max-h-[88vh] w-full ${width} overflow-hidden rounded-2xl shadow-glass`}
            initial={{ opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          >
            {title && (
              <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-5">
                <div>
                  <h2 className="text-lg font-semibold text-white">{title}</h2>
                  {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
                </div>
                <button className="icon-btn -mr-2" onClick={onClose} aria-label="Закрыть">
                  <X className="h-5 w-5" />
                </button>
              </div>
            )}
            <div className="max-h-[calc(88vh-80px)] overflow-y-auto">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="accent-ring flex h-16 w-16 items-center justify-center rounded-2xl bg-white/5 text-slate-200">{icon}</div>
      <div className="text-lg font-semibold text-white">{title}</div>
      {body && <div className="max-w-sm text-sm text-slate-400">{body}</div>}
      {action}
    </div>
  );
}
