import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useUi } from '@/stores/ui';

export function ContextMenu() {
  const menu = useUi((s) => s.contextMenu);
  const close = useUi((s) => s.closeContextMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 8),
      y: Math.min(menu.y, window.innerHeight - r.height - 8),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [menu, close]);

  return (
    <AnimatePresence>
      {menu && (
        <motion.div
          ref={ref}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.1 }}
          className="glass-strong fixed z-[60] min-w-[200px] rounded-xl p-1.5 shadow-glass"
          style={{ left: pos.x || menu.x, top: pos.y || menu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menu.items.map((item, i) =>
            item.separator ? (
              <div key={i} className="my-1 h-px bg-white/10" />
            ) : (
              <button
                key={i}
                disabled={item.disabled}
                onClick={() => {
                  close();
                  item.onClick?.();
                }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition disabled:opacity-40 ${
                  item.danger ? 'text-rose-300 hover:bg-rose-500/20' : 'text-slate-200 hover:bg-white/10'
                }`}
              >
                {item.icon && <span className="h-4 w-4 shrink-0 [&>svg]:h-4 [&>svg]:w-4">{item.icon}</span>}
                {item.label}
              </button>
            ),
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-20 right-5 z-[70] flex w-[360px] flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            className="glass-strong pointer-events-auto flex items-start gap-3 rounded-xl p-3.5 shadow-glass"
          >
            <div className="mt-0.5">
              {t.kind === 'error' ? (
                <AlertCircle className="h-5 w-5 text-rose-400" />
              ) : t.kind === 'success' ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              ) : (
                <Info className="h-5 w-5 text-sky-300" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-white">{t.title}</div>
              {t.body && <div className="mt-0.5 break-words text-xs text-slate-400">{t.body}</div>}
              {t.action && (
                <button
                  className="mt-2 text-xs font-semibold text-indigo-300 hover:text-indigo-200"
                  onClick={() => {
                    t.action!.onClick();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button className="text-slate-500 hover:text-slate-200" onClick={() => dismiss(t.id)}>
              <X className="h-4 w-4" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
