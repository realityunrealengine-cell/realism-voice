import { useEffect, useRef, useState } from 'react';
import { Keyboard, Mic, Video } from 'lucide-react';
import { useSettings, type Prefs } from '@/stores/settings';
import { useVoice } from '@/stores/voice';
import { createMicTester } from '@/lib/voiceGate';
import { Field, Select, Slider, Switch } from '@/components/ui/primitives';
import { toast } from '@/stores/ui';
import { Card, Row } from './parts';

function useDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = async () => {
      try {
        // Метки устройств доступны только после разрешения на доступ к медиа
        const list = await navigator.mediaDevices.enumerateDevices();
        if (list.some((d) => d.kind === 'audioinput' && !d.label)) {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
          s?.getTracks().forEach((t) => t.stop());
          setDevices(await navigator.mediaDevices.enumerateDevices());
        } else setDevices(list);
      } catch {
        setDevices([]);
      }
    };
    void load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => navigator.mediaDevices.removeEventListener('devicechange', load);
  }, []);
  return devices;
}

function deviceOptions(devices: MediaDeviceInfo[], kind: MediaDeviceKind, withDefault = true) {
  const list = devices.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return [
    ...(withDefault ? [{ value: 'default', label: 'По умолчанию (Windows)' }] : []),
    ...list.map((d, i) => ({ value: d.deviceId, label: d.label || `Устройство ${i + 1}` })),
  ];
}

export const KEY_LABELS: Record<string, string> = {
  Backquote: '`', Space: 'Пробел', CapsLock: 'Caps Lock', Tab: 'Tab', ControlLeft: 'Левый Ctrl', ControlRight: 'Правый Ctrl',
  ShiftLeft: 'Левый Shift', ShiftRight: 'Правый Shift', AltLeft: 'Левый Alt', AltRight: 'Правый Alt', Mouse4: 'Кнопка мыши 4', Mouse5: 'Кнопка мыши 5', Mouse3: 'Средняя кнопка мыши',
};

export function keyLabel(code: string): string {
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  const m = code.match(/^Key([A-Z])$/) ?? code.match(/^Digit(\d)$/);
  return m ? m[1] : code;
}

export function PttCapture() {
  const binding = useSettings((s) => s.prefs.pttBinding);
  const [capturing, setCapturing] = useState(false);
  const [globalOk, setGlobalOk] = useState<boolean | null>(null);
  useEffect(() => {
    void window.rv?.ptt.isGlobalAvailable().then(setGlobalOk);
  }, []);
  useEffect(() => {
    if (!capturing) return;
    const save = (code: string) => {
      setCapturing(false);
      useSettings.getState().setPrefs({ pttBinding: { code, label: keyLabel(code) } });
      void useVoice.getState().applyPrefs();
    };
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      // Esc отменяет назначение клавиши и не должен закрывать экран настроек
      e.stopPropagation();
      if (e.code === 'Escape') return setCapturing(false);
      save(e.code);
    };
    const mouse = (e: MouseEvent) => {
      if (e.button >= 2) {
        e.preventDefault();
        save(`Mouse${e.button + 1}`);
      }
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('mousedown', mouse, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('mousedown', mouse, true);
    };
  }, [capturing]);
  return (
    <div>
      <button
        className={`flex w-full items-center justify-between rounded-xl border px-4 py-2.5 text-sm ${capturing ? 'border-[color:var(--a2)] bg-white/10 text-white' : 'border-white/10 bg-black/30 text-slate-200'}`}
        onClick={() => setCapturing(true)}
      >
        <span className="flex items-center gap-2">
          <Keyboard className="h-4 w-4" /> {capturing ? 'Нажмите клавишу или боковую кнопку мыши… (Esc — отмена)' : binding.label}
        </span>
        <span className="text-xs text-slate-500">Изменить</span>
      </button>
      {globalOk === false && <p className="mt-1.5 text-xs text-amber-300">Глобальный перехват клавиш недоступен: PTT работает, только когда окно Realism Voice активно.</p>}
      {globalOk && <p className="mt-1.5 text-xs text-slate-500">Работает в любом приложении, пока вы подключены к голосовому каналу.</p>}
    </div>
  );
}

function MicTest({ prefs }: { prefs: Prefs }) {
  const [level, setLevel] = useState(-100);
  const [running, setRunning] = useState(false);
  const [loopback, setLoopback] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const stop = () => {
    stopRef.current?.();
    stopRef.current = null;
    setRunning(false);
    setLevel(-100);
  };
  useEffect(() => stop, []);
  const start = async () => {
    stop();
    try {
      stopRef.current = await createMicTester(
        prefs.inputDeviceId,
        { echoCancellation: prefs.echoCancellation, noiseSuppression: prefs.noiseSuppression, autoGainControl: prefs.autoGainControl },
        setLevel,
        loopback,
      );
      setRunning(true);
    } catch (e) {
      toast.error('Микрофон недоступен', (e as Error).message);
    }
  };
  const pct = Math.max(0, Math.min(100, ((level + 90) / 80) * 100));
  const thr = ((prefs.vadThreshold + 90) / 80) * 100;
  return (
    <div>
      <div className="relative h-3 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full transition-[width] duration-75" style={{ width: `${pct}%`, background: level > prefs.vadThreshold ? '#34d399' : 'var(--a1)' }} />
        {prefs.voiceMode === 'vad' && <div className="absolute top-0 h-full w-0.5 bg-white" style={{ left: `${thr}%` }} title="Порог чувствительности" />}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button className={running ? 'btn-ghost' : 'btn-primary'} onClick={() => (running ? stop() : void start())}>
          <Mic className="h-4 w-4" /> {running ? 'Остановить проверку' : 'Проверить микрофон'}
        </button>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <Switch checked={loopback} onChange={(v) => setLoopback(v)} disabled={running} /> Слышать себя
        </label>
      </div>
    </div>
  );
}

function CameraPreview({ deviceId }: { deviceId: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    void navigator.mediaDevices
      .getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true })
      .then((s) => {
        stream = s;
        if (ref.current) ref.current.srcObject = s;
      })
      .catch((e) => {
        toast.error('Камера недоступна', e.message);
        setOn(false);
      });
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [on, deviceId]);
  return (
    <div>
      <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl bg-black/40">
        {on ? <video ref={ref} autoPlay muted playsInline className="mirror h-full w-full object-cover" /> : <Video className="h-8 w-8 text-slate-600" />}
      </div>
      <button className="btn-ghost mt-3" onClick={() => setOn(!on)}>
        {on ? 'Выключить предпросмотр' : 'Проверить камеру'}
      </button>
    </div>
  );
}

export function VoiceSection() {
  const prefs = useSettings((s) => s.prefs);
  const devices = useDevices();
  const set = (patch: Partial<Prefs>) => {
    useSettings.getState().setPrefs(patch);
    void useVoice.getState().applyPrefs();
  };
  const outputSupported = typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === 'function';

  return (
    <div className="space-y-6">
      <Card>
        <h3 className="mb-4 font-semibold text-white">Устройства</h3>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Устройство ввода">
            <Select value={prefs.inputDeviceId} onChange={(v) => set({ inputDeviceId: v })} options={deviceOptions(devices, 'audioinput')} />
          </Field>
          <Field label="Устройство вывода" hint={outputSupported ? undefined : 'Выбор устройства вывода не поддерживается'}>
            <Select value={prefs.outputDeviceId} onChange={(v) => set({ outputDeviceId: v })} options={deviceOptions(devices, 'audiooutput')} />
          </Field>
          <Field label={`Громкость микрофона — ${prefs.inputVolume}%`}>
            <Slider value={prefs.inputVolume} min={0} max={200} step={5} onChange={(v) => set({ inputVolume: v })} />
          </Field>
          <Field label={`Громкость звука — ${prefs.outputVolume}%`}>
            <Slider value={prefs.outputVolume} min={0} max={200} step={5} onChange={(v) => set({ outputVolume: v })} />
          </Field>
        </div>
        <div className="mt-5">
          <span className="label">Проверка микрофона</span>
          <MicTest prefs={prefs} />
        </div>
      </Card>

      <Card>
        <h3 className="mb-4 font-semibold text-white">Режим ввода</h3>
        <div className="grid grid-cols-2 gap-3">
          {(['vad', 'ptt'] as const).map((m) => (
            <button
              key={m}
              onClick={() => set({ voiceMode: m })}
              className={`rounded-xl border px-4 py-3 text-left transition ${prefs.voiceMode === m ? 'border-[color:var(--a2)] bg-white/10' : 'border-white/5 bg-black/20 hover:bg-white/5'}`}
            >
              <div className="text-sm font-medium text-white">{m === 'vad' ? 'Активация голосом' : 'Push-to-Talk'}</div>
              <div className="text-xs text-slate-400">{m === 'vad' ? 'Микрофон передаёт звук, когда вы говорите' : 'Звук передаётся, пока удерживаете клавишу'}</div>
            </button>
          ))}
        </div>
        {prefs.voiceMode === 'vad' ? (
          <div className="mt-5">
            <Field label={`Чувствительность — порог ${prefs.vadThreshold} дБ`} hint="Чем левее, тем тише звук, который будет передаваться. Белая отметка на индикаторе — текущий порог.">
              <Slider value={prefs.vadThreshold} min={-90} max={-10} onChange={(v) => set({ vadThreshold: v })} />
            </Field>
          </div>
        ) : (
          <div className="mt-5 space-y-4">
            <Field label="Клавиша Push-to-Talk">
              <PttCapture />
            </Field>
            <Field label={`Задержка отпускания — ${prefs.pttReleaseDelay} мс`}>
              <Slider value={prefs.pttReleaseDelay} min={0} max={1000} step={20} onChange={(v) => set({ pttReleaseDelay: v })} />
            </Field>
          </div>
        )}
      </Card>

      <Card>
        <h3 className="mb-1 font-semibold text-white">Обработка голоса</h3>
        <Row title="Эхоподавление" desc="Убирает эхо от динамиков">
          <Switch checked={prefs.echoCancellation} onChange={(v) => set({ echoCancellation: v })} />
        </Row>
        <Row title="Шумоподавление" desc="Подавляет фоновый шум (вентиляторы, клавиатура)">
          <Switch checked={prefs.noiseSuppression} onChange={(v) => set({ noiseSuppression: v })} />
        </Row>
        <Row title="Автоматическая регулировка усиления" desc="Выравнивает громкость голоса">
          <Switch checked={prefs.autoGainControl} onChange={(v) => set({ autoGainControl: v })} />
        </Row>
      </Card>

      <Card>
        <h3 className="mb-4 font-semibold text-white">Видео</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-4">
            <Field label="Камера">
              <Select
                value={prefs.videoDeviceId || (devices.find((d) => d.kind === 'videoinput')?.deviceId ?? '')}
                onChange={(v) => set({ videoDeviceId: v })}
                options={deviceOptions(devices, 'videoinput', false).length ? deviceOptions(devices, 'videoinput', false) : [{ value: '', label: 'Камера не найдена' }]}
              />
            </Field>
            <Field label="Качество камеры">
              <Select
                value={prefs.cameraQuality}
                onChange={(v) => set({ cameraQuality: v })}
                options={[
                  { value: '480p', label: '540p' },
                  { value: '720p', label: '720p' },
                  { value: '1080p', label: '1080p' },
                ]}
              />
            </Field>
          </div>
          <CameraPreview deviceId={prefs.videoDeviceId} />
        </div>
      </Card>
    </div>
  );
}
