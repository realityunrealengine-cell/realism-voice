import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Download, X } from 'lucide-react';
import { useCalls } from '@/stores/calls';
import { useUpdates } from '@/stores/updates';
import { useVoice } from '@/stores/voice';

/** Голосовой канал, личный звонок, демонстрация экрана или входящий вызов */
export function useInCall(): boolean {
  const voice = useVoice((s) => s.status === 'connecting' || s.status === 'connected' || s.status === 'reconnecting');
  const ringing = useCalls((s) => s.incoming !== null);
  return voice || ringing;
}

// Ненавязчивая карточка, а не модальное окно: не забирает фокус у чата и не закрывается вместе с настройками по Esc.
export function UpdateNotice() {
  const phase = useUpdates((s) => s.state?.phase);
  const version = useUpdates((s) => s.state?.availableVersion);
  const notice = useUpdates((s) => s.notice);
  const inCall = useInCall();
  const announced = useRef<string | null>(null);
  const wasInCall = useRef(inCall);

  useEffect(() => useUpdates.getState().init(), []);

  useEffect(() => {
    window.rv?.updates.setInCall(inCall);
  }, [inCall]);

  useEffect(() => {
    const { setNotice } = useUpdates.getState();
    const callEnded = wasInCall.current && !inCall;
    const callStarted = !wasInCall.current && inCall;
    wasInCall.current = inCall;
    if (phase !== 'downloaded' || !version) {
      setNotice(null);
      return;
    }
    if (announced.current !== version) {
      announced.current = version;
      setNotice(inCall ? 'in-call' : 'ready');
    } else if (callEnded) {
      setNotice('ready');
    } else if (callStarted) {
      setNotice(null);
    }
  }, [phase, version, inCall]);

  // Во время звонка уведомление не должно закрывать кнопки: значок в заголовке окна остаётся
  useEffect(() => {
    if (notice !== 'in-call') return;
    const timer = setTimeout(() => useUpdates.getState().setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const { install, setNotice } = useUpdates.getState();
  return (
    <AnimatePresence>
      {notice && (
        <motion.div
          key={notice}
          initial={{ opacity: 0, x: 40 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 40 }}
          className="glass-strong fixed right-5 top-12 z-[65] w-[360px] rounded-xl p-4 shadow-glass"
          role="status"
        >
          <div className="flex items-start gap-3">
            <Download className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
            <div className="min-w-0 flex-1">
              {notice === 'ready' ? (
                <>
                  <div className="text-sm font-medium text-white">Обновление готово. Перезапустить Realism Voice?</div>
                  <div className="mt-0.5 text-xs text-slate-400">Версия {version} загружена и проверена. Вход и настройки сохранятся.</div>
                  <div className="mt-3 flex gap-2">
                    <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => void install()}>
                      Обновить и перезапустить
                    </button>
                    <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setNotice(null)}>
                      Позже
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="text-sm font-medium text-white">Обновление готово</div>
                  <div className="mt-0.5 text-xs text-slate-400">Версия {version} загружена. Звонок не прервётся: перезапуск будет предложен после его завершения.</div>
                </>
              )}
            </div>
            <button className="text-slate-500 hover:text-slate-200" onClick={() => setNotice(null)} aria-label="Закрыть">
              <X className="h-4 w-4" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
