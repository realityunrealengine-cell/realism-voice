import { useEffect, useState } from 'react';
import { Bell, Shield } from 'lucide-react';
import { ACCENTS, useSettings, type AccentTheme } from '@/stores/settings';
import { toast } from '@/stores/ui';
import { sounds } from '@/lib/sounds';
import { Select, Slider, Switch } from '@/components/ui/primitives';
import { LogoMark } from '@/components/ui/Logo';
import { Card, Row } from './parts';
import { PttCapture } from './VoiceSection';

export function NotificationsSection() {
  const n = useSettings((s) => s.prefs.notifications);
  const soundsOn = useSettings((s) => s.prefs.sounds);
  const set = useSettings.getState().setNotifications;
  const [permission, setPermission] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
  return (
    <div>
      <Row title="Уведомления на рабочем столе" desc="Показываются, когда окно Realism Voice не в фокусе">
        <Switch checked={n.desktop} onChange={(v) => set({ desktop: v })} />
      </Row>
      <Row title="Личные сообщения" desc="Уведомлять о новых сообщениях в личных переписках">
        <Switch checked={n.dms} onChange={(v) => set({ dms: v })} />
      </Row>
      <Row title="Заявки в друзья">
        <Switch checked={n.friendRequests} onChange={(v) => set({ friendRequests: v })} />
      </Row>
      <Row title="Сообщения на серверах" desc="Можно отключить отдельные серверы через контекстное меню их иконки">
        <div className="w-52">
          <Select
            value={n.serverMode}
            onChange={(v) => set({ serverMode: v })}
            options={[
              { value: 'all', label: 'Все сообщения' },
              { value: 'mentions', label: 'Только @упоминания' },
              { value: 'none', label: 'Ничего' },
            ]}
          />
        </div>
      </Row>
      <Row title="Мигание на панели задач" desc="Привлекать внимание к новому сообщению">
        <Switch checked={n.flash} onChange={(v) => set({ flash: v })} />
      </Row>
      <Row title="Звуки" desc="Звуки сообщений, подключения и отключения микрофона">
        <Switch checked={soundsOn} onChange={(v) => useSettings.getState().setPrefs({ sounds: v })} />
      </Row>
      <div className="mt-5 flex gap-2">
        <button
          className="btn-ghost"
          onClick={async () => {
            if (permission !== 'granted') setPermission(await Notification.requestPermission());
            new Notification('Realism Voice', { body: 'Так будут выглядеть уведомления', silent: true });
            sounds.message();
          }}
        >
          <Bell className="h-4 w-4" /> Тестовое уведомление
        </button>
      </div>
    </div>
  );
}

function AcceleratorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [capturing, setCapturing] = useState(false);
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      // Esc отменяет назначение сочетания и не должен закрывать экран настроек
      e.stopPropagation();
      if (e.key === 'Escape') return setCapturing(false);
      if (e.key === 'Backspace') {
        setCapturing(false);
        return onChange('');
      }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean) as string[];
      let key = e.code.replace(/^Key/, '').replace(/^Digit/, '');
      if (/^Numpad\d$/.test(e.code)) key = `num${e.code.slice(6)}`;
      if (key.startsWith('Arrow')) key = key.slice(5);
      if (mods.length === 0 && !/^F\d+$/.test(key)) return toast.error('Добавьте модификатор', 'Используйте Ctrl, Alt или Shift вместе с клавишей');
      setCapturing(false);
      onChange([...mods, key].join('+'));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, onChange]);
  return (
    <button
      onClick={() => setCapturing(true)}
      className={`w-56 rounded-xl border px-3 py-2 text-left font-mono text-sm ${capturing ? 'border-[color:var(--a2)] bg-white/10 text-white' : 'border-white/10 bg-black/30 text-slate-200'}`}
    >
      {capturing ? 'Нажмите сочетание…' : value || 'Не назначено'}
    </button>
  );
}

export function HotkeysSection() {
  const app = useSettings((s) => s.app);
  if (!app) return <div className="text-sm text-slate-400">Горячие клавиши доступны только в приложении для Windows.</div>;
  const setHotkey = (k: 'toggleMute' | 'toggleDeafen', v: string) =>
    void useSettings.getState().setApp({ hotkeys: { ...app.hotkeys, [k]: v } });
  return (
    <div>
      <p className="mb-2 text-sm text-slate-400">Глобальные сочетания работают, даже когда Realism Voice свёрнут. Backspace — сбросить сочетание.</p>
      <Row title="Включить / выключить микрофон">
        <AcceleratorInput value={app.hotkeys.toggleMute} onChange={(v) => setHotkey('toggleMute', v)} />
      </Row>
      <Row title="Включить / выключить звук">
        <AcceleratorInput value={app.hotkeys.toggleDeafen} onChange={(v) => setHotkey('toggleDeafen', v)} />
      </Row>
      <div className="border-b border-white/5 py-4">
        <div className="mb-2 text-sm font-medium text-white">Push-to-Talk</div>
        <PttCapture />
        <p className="mt-2 text-xs text-slate-500">Режим Push-to-Talk включается в разделе «Голос и видео».</p>
      </div>
      <div className="mt-4 rounded-xl bg-black/20 p-4 text-xs leading-relaxed text-slate-400">
        <div className="mb-1 font-semibold text-slate-300">Клавиши в чате</div>
        Enter — отправить · Shift+Enter — новая строка · ↑ — редактировать последнее сообщение · Esc — отменить ответ · @ — упомянуть участника
      </div>
    </div>
  );
}

export function AppearanceSection() {
  const a = useSettings((s) => s.prefs.appearance);
  const set = useSettings.getState().setAppearance;
  return (
    <div>
      <div className="mb-6">
        <span className="label">Цветовая тема</span>
        <div className="grid grid-cols-4 gap-3">
          {(Object.keys(ACCENTS) as AccentTheme[]).map((k) => (
            <button
              key={k}
              onClick={() => set({ accent: k })}
              className={`rounded-xl border p-3 text-left transition ${a.accent === k ? 'border-white/50 bg-white/10' : 'border-white/5 bg-black/20 hover:bg-white/5'}`}
            >
              <div className="mb-2 h-10 rounded-lg" style={{ background: `linear-gradient(135deg, ${ACCENTS[k].a1}, ${ACCENTS[k].a2})` }} />
              <div className="text-xs text-slate-300">{ACCENTS[k].label}</div>
            </button>
          ))}
        </div>
      </div>
      <Row title={`Размер шрифта — ${a.fontScale}%`}>
        <div className="w-56">
          <Slider value={a.fontScale} min={85} max={125} step={5} onChange={(v) => set({ fontScale: v })} />
        </div>
      </Row>
      <Row title="Компактный режим сообщений" desc="Меньше отступов между сообщениями">
        <Switch checked={a.compact} onChange={(v) => set({ compact: v })} />
      </Row>
      <Row title="Эффект стекла" desc="Полупрозрачные панели с размытием фона">
        <Switch checked={a.glass} onChange={(v) => set({ glass: v })} />
      </Row>
      <Row title="Уменьшить анимации">
        <Switch checked={a.reduceMotion} onChange={(v) => set({ reduceMotion: v })} />
      </Row>
    </div>
  );
}

export function WindowsSection() {
  const app = useSettings((s) => s.app);
  if (!app) return <div className="text-sm text-slate-400">Эти настройки доступны только в приложении для Windows.</div>;
  const set = (patch: Parameters<ReturnType<typeof useSettings.getState>['setApp']>[0]) => void useSettings.getState().setApp(patch);
  return (
    <div>
      <Row title="Запускать при входе в Windows" desc="Работает в установленной версии приложения">
        <Switch checked={app.autostart} onChange={(v) => set({ autostart: v })} />
      </Row>
      <Row title="Запускать свёрнутым" desc="При автозапуске окно не открывается, приложение ждёт в трее">
        <Switch checked={app.startMinimized} onChange={(v) => set({ startMinimized: v })} />
      </Row>
      <Row title="Сворачивать в системный трей" desc="Кнопка «Свернуть» прячет окно в трей">
        <Switch checked={app.minimizeToTray} onChange={(v) => set({ minimizeToTray: v })} />
      </Row>
      <Row title="Закрывать в трей" desc="Кнопка «Закрыть» не завершает приложение — вы остаётесь на связи">
        <Switch checked={app.closeToTray} onChange={(v) => set({ closeToTray: v })} />
      </Row>
      <Row title="Аппаратное ускорение" desc="Изменение вступит в силу после перезапуска">
        <Switch checked={app.hardwareAcceleration} onChange={(v) => set({ hardwareAcceleration: v })} />
      </Row>
      <div className="mt-5">
        <button className="btn-ghost text-rose-300" onClick={() => window.rv?.app.quit()}>
          Полностью выйти из Realism Voice
        </button>
      </div>
    </div>
  );
}

export function AboutSection() {
  const [v, setV] = useState<{ app: string; electron: string; chrome: string; node: string } | null>(null);
  useEffect(() => {
    void window.rv?.app.getVersion().then(setV);
  }, []);
  return (
    <div className="space-y-5">
      <Card className="flex items-center gap-5">
        <LogoMark size={72} />
        <div>
          <div className="text-2xl font-bold text-white">
            Realism <span className="accent-text">Voice</span>
          </div>
          <div className="text-sm text-slate-400">Версия {v?.app ?? '—'}</div>
        </div>
      </Card>
      <Card>
        <div className="grid grid-cols-2 gap-y-2 text-sm">
          <span className="text-slate-400">Electron</span>
          <span className="text-slate-200">{v?.electron ?? '—'}</span>
          <span className="text-slate-400">Chromium</span>
          <span className="text-slate-200">{v?.chrome ?? '—'}</span>
          <span className="text-slate-400">Node.js</span>
          <span className="text-slate-200">{v?.node ?? '—'}</span>
          <span className="text-slate-400">Голосовой движок</span>
          <span className="text-slate-200">Cloudflare Realtime SFU (WebRTC)</span>
          <span className="text-slate-400">Сервер данных</span>
          <span className="text-slate-200">Supabase</span>
        </div>
      </Card>
      <Card className="flex items-start gap-3 text-sm text-slate-400">
        <Shield className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
        Права доступа проверяются на сервере (PostgreSQL RLS, Edge Functions). Секретные ключи голосового сервера никогда не попадают в приложение.
      </Card>
    </div>
  );
}
