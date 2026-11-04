import { useEffect, useState } from 'react';
import { AppWindow, Monitor, RefreshCw } from 'lucide-react';
import type { ScreenSource } from '../../../electron/shared';
import { useVoice } from '@/stores/voice';
import { useSettings } from '@/stores/settings';
import { ModalShell, Select, Spinner, Switch } from '@/components/ui/primitives';

export function ScreenPicker({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [tab, setTab] = useState<'screen' | 'window'>('screen');
  const [selected, setSelected] = useState<string | null>(null);
  const screenAudio = useSettings((s) => s.prefs.screenAudio);
  const quality = useSettings((s) => s.prefs.screenQuality);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setSources(null);
    if (!window.rv) {
      setSources([]);
      return;
    }
    setSources(await window.rv.screen.getSources());
  };

  useEffect(() => {
    void load();
  }, []);

  const list = (sources ?? []).filter((s) => s.kind === tab);

  const start = async () => {
    if (!selected) return;
    setBusy(true);
    await useVoice.getState().startScreen(selected, screenAudio);
    setBusy(false);
    onClose();
  };

  return (
    <ModalShell open onClose={onClose} width="max-w-3xl" title="Демонстрация экрана" subtitle="Выберите экран или окно приложения">
      <div className="px-6 pb-6">
        <div className="mb-4 flex items-center gap-2">
          {(['screen', 'window'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm ${tab === t ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5'}`}
            >
              {t === 'screen' ? <Monitor className="h-4 w-4" /> : <AppWindow className="h-4 w-4" />}
              {t === 'screen' ? 'Экраны' : 'Окна'}
            </button>
          ))}
          <div className="flex-1" />
          <button className="icon-btn" title="Обновить" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        {!sources ? (
          <div className="flex h-60 items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        ) : (
          <div className="grid max-h-[46vh] grid-cols-3 gap-3 overflow-y-auto pr-1">
            {list.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelected(s.id)}
                onDoubleClick={() => {
                  setSelected(s.id);
                  void start();
                }}
                className={`rounded-xl border p-2 text-left transition ${selected === s.id ? 'border-[color:var(--a2)] bg-white/10' : 'border-white/5 bg-black/20 hover:bg-white/5'}`}
              >
                <img src={s.thumbnail} alt="" className="aspect-video w-full rounded-lg bg-black object-contain" />
                <div className="mt-2 flex items-center gap-1.5 text-xs text-slate-300">
                  {s.appIcon && <img src={s.appIcon} alt="" className="h-4 w-4" />}
                  <span className="truncate">{s.name}</span>
                </div>
              </button>
            ))}
            {list.length === 0 && <div className="col-span-3 py-10 text-center text-sm text-slate-500">Источники не найдены</div>}
          </div>
        )}
        <div className="mt-5 flex flex-wrap items-center gap-4 border-t border-white/5 pt-4">
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <Switch checked={screenAudio} onChange={(v) => useSettings.getState().setPrefs({ screenAudio: v })} />
            Транслировать звук системы
          </label>
          <div className="w-44">
            <Select
              value={quality}
              onChange={(v) => useSettings.getState().setPrefs({ screenQuality: v })}
              options={[
                { value: '720p', label: '720p · 30 кадров' },
                { value: '1080p', label: '1080p · 15 кадров' },
                { value: '1080p60', label: '1080p · 30 кадров' },
              ]}
            />
          </div>
          <div className="flex-1" />
          <button className="btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn-primary" disabled={!selected || busy} onClick={() => void start()}>
            {busy && <Spinner />} Начать трансляцию
          </button>
        </div>
        {screenAudio && (
          <p className="mt-2 text-xs text-slate-500">
            Windows передаёт весь звук системы (включая голоса собеседников, если они звучат через динамики). Рекомендуется использовать наушники.
          </p>
        )}
      </div>
    </ModalShell>
  );
}
