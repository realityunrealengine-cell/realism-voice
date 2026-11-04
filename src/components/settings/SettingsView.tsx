import { motion, useIsPresent } from 'framer-motion';
import { X, LogOut } from 'lucide-react';
import { useEffect } from 'react';
import { useUi } from '@/stores/ui';
import { useAuth } from '@/stores/auth';
import { AccountSection, PrivacySection, ProfileSection } from './AccountSections';
import { VoiceSection } from './VoiceSection';
import { AboutSection, AppearanceSection, HotkeysSection, NotificationsSection, WindowsSection } from './AppSections';
import { UpdatesSection } from './UpdatesSection';

const SECTIONS: { group: string; items: { id: string; label: string }[] }[] = [
  {
    group: 'Настройки пользователя',
    items: [
      { id: 'account', label: 'Мой аккаунт' },
      { id: 'profile', label: 'Профиль' },
      { id: 'privacy', label: 'Конфиденциальность' },
    ],
  },
  {
    group: 'Настройки приложения',
    items: [
      { id: 'notifications', label: 'Уведомления' },
      { id: 'voice', label: 'Голос и видео' },
      { id: 'hotkeys', label: 'Горячие клавиши' },
      { id: 'appearance', label: 'Внешний вид' },
      { id: 'windows', label: 'Windows' },
      { id: 'updates', label: 'Обновления' },
      { id: 'about', label: 'О приложении' },
    ],
  },
];

export function SettingsView() {
  const section = useUi((s) => s.settingsSection);
  const close = useUi((s) => s.closeSettings);
  const isPresent = useIsPresent();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !useUi.getState().modal) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const label = SECTIONS.flatMap((g) => g.items).find((i) => i.id === section)?.label;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 1.02 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.02 }}
      transition={{ duration: 0.18 }}
      // Закрывающийся экран настроек не должен перехватывать клики, пока идёт анимация исчезновения
      className={`fixed inset-x-0 bottom-0 top-9 z-40 flex bg-base-950/95 backdrop-blur-xl ${isPresent ? '' : 'pointer-events-none'}`}
    >
      <aside className="flex w-[280px] shrink-0 justify-end overflow-y-auto bg-black/20 py-10 pr-3">
        <nav className="w-52">
          {SECTIONS.map((g) => (
            <div key={g.group} className="mb-4">
              <div className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{g.group}</div>
              {g.items.map((i) => (
                <button
                  key={i.id}
                  onClick={() => useUi.getState().openSettings(i.id)}
                  className={`mb-0.5 w-full rounded-lg px-2.5 py-1.5 text-left text-sm transition ${
                    section === i.id ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                  }`}
                >
                  {i.label}
                </button>
              ))}
            </div>
          ))}
          <div className="my-2 h-px bg-white/10" />
          <button
            onClick={() => {
              close();
              void useAuth.getState().signOut();
            }}
            className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm text-rose-300 hover:bg-rose-500/10"
          >
            Выйти <LogOut className="h-4 w-4" />
          </button>
        </nav>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="max-w-[760px] px-10 py-10">
          <h1 className="mb-6 text-xl font-bold text-white">{label}</h1>
          {section === 'account' && <AccountSection />}
          {section === 'profile' && <ProfileSection />}
          {section === 'privacy' && <PrivacySection />}
          {section === 'notifications' && <NotificationsSection />}
          {section === 'voice' && <VoiceSection />}
          {section === 'hotkeys' && <HotkeysSection />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'windows' && <WindowsSection />}
          {section === 'updates' && <UpdatesSection />}
          {section === 'about' && <AboutSection />}
        </div>
      </div>
      <div className="w-24 shrink-0 pt-10">
        <button onClick={close} className="flex flex-col items-center gap-1 text-xs text-slate-400 hover:text-white">
          <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-current">
            <X className="h-4 w-4" />
          </span>
          ESC
        </button>
      </div>
    </motion.div>
  );
}
