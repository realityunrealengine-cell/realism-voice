import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Database, RefreshCw } from 'lucide-react';
import { configError } from '@/lib/supabase';
import { bootstrap, teardown } from '@/lib/realtime';
import { useAuth } from '@/stores/auth';
import { ACCENTS, useSettings } from '@/stores/settings';
import { useUi } from '@/stores/ui';
import { useConnectivity } from '@/stores/connectivity';
import { subscribeTransferEvents } from '@/stores/transfers';
import type { DeepLink } from '../electron/shared';
import { AuthScreen } from '@/components/auth/AuthScreen';
import { AppShell } from '@/components/layout/AppShell';
import { Backdrop } from '@/components/layout/Backdrop';
import { TitleBar } from '@/components/layout/TitleBar';
import { LogoMark } from '@/components/ui/Logo';
import { ContextMenu, Toasts } from '@/components/ui/Overlays';
import { UpdateNotice } from '@/components/ui/UpdateNotice';
import { UpdatesModal } from '@/components/settings/UpdatesSection';

let pendingInvite: string | null = null;

function useAppearance() {
  const appearance = useSettings((s) => s.prefs.appearance);
  useEffect(() => {
    const root = document.documentElement;
    const a = ACCENTS[appearance.accent] ?? ACCENTS.violet;
    root.style.setProperty('--a1', a.a1);
    root.style.setProperty('--a2', a.a2);
    root.style.setProperty('--font-scale', String(appearance.fontScale / 100));
    root.classList.toggle('reduce-motion', appearance.reduceMotion);
    root.classList.toggle('no-glass', !appearance.glass);
  }, [appearance]);
}

function handleDeepLink(link: DeepLink) {
  if (link.type === 'auth') {
    void useAuth.getState().handleAuthLink(link);
  } else if (link.type === 'invite') {
    if (useAuth.getState().status === 'signedIn') useUi.getState().openModal({ type: 'joinServer', code: link.code });
    else pendingInvite = link.code;
  }
}

function Splash() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5">
      <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ repeat: Infinity, duration: 1.6 }}>
        <LogoMark size={72} />
      </motion.div>
      <div className="text-sm text-slate-400">Подключение…</div>
    </div>
  );
}

function SetupRequired({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="glass max-w-xl rounded-2xl p-8 shadow-glass">
        <div className="mb-4 flex items-center gap-3">
          <Database className="h-7 w-7 text-amber-300" />
          <h1 className="text-xl font-semibold text-white">Требуется настройка Supabase</h1>
        </div>
        <p className="text-sm leading-relaxed text-slate-300">{message}</p>
        <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm text-slate-400">
          <li>Откройте Supabase Dashboard → SQL Editor.</li>
          <li>Вставьте содержимое файла <code className="text-slate-200">supabase/setup.sql</code> и нажмите Run.</li>
          <li>Перезапустите приложение.</li>
        </ol>
        <div className="mt-6 flex gap-3">
          <button className="btn-primary" onClick={() => location.reload()}>
            <RefreshCw className="h-4 w-4" /> Проверить снова
          </button>
          <button className="btn-ghost" onClick={() => void useAuth.getState().signOut()}>
            Выйти
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  useAppearance();
  const status = useAuth((s) => s.status);
  const profile = useAuth((s) => s.profile);
  const booted = useRef<string | null>(null);

  useEffect(() => {
    if (configError) return;
    void useAuth.getState().init();
    void useSettings.getState().loadApp();
    const off = window.rv?.app.onDeepLink(handleDeepLink);
    void window.rv?.app.consumeDeepLink().then((l) => l && handleDeepLink(l));
    const offNet = useConnectivity.getState().init();
    subscribeTransferEvents();
    return () => {
      off?.();
      offNet();
    };
  }, []);

  useEffect(() => {
    if (status === 'signedIn' && profile && booted.current !== profile.id) {
      booted.current = profile.id;
      void bootstrap().then(() => {
        if (pendingInvite) {
          useUi.getState().openModal({ type: 'joinServer', code: pendingInvite });
          pendingInvite = null;
        }
      });
    }
    if (status === 'signedOut' && booted.current) {
      booted.current = null;
      teardown();
    }
  }, [status, profile]);

  let content: JSX.Element;
  if (configError) content = <SetupRequired message={configError} />;
  else if (status === 'loading') content = <Splash />;
  else if (status === 'dbMissing')
    content = (
      <SetupRequired message="Приложение подключилось к Supabase, но таблицы Realism Voice ещё не созданы (или профиль не найден). Примените SQL-миграции." />
    );
  else if (status === 'signedIn' && profile) content = <AppShell />;
  else if (status === 'signedIn') content = <Splash />;
  else content = <AuthScreen />;

  return (
    <div className="relative flex h-full flex-col">
      <Backdrop />
      <TitleBar />
      <AnimatePresence mode="wait">
        <motion.div
          key={status === 'signedIn' ? 'app' : status}
          className="relative min-h-0 flex-1"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
        >
          {content}
        </motion.div>
      </AnimatePresence>
      <ContextMenu />
      <UpdatesModal />
      <UpdateNotice />
      <Toasts />
    </div>
  );
}
