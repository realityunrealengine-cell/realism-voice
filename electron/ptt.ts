// Глобальный Push-to-Talk: работает даже когда окно не в фокусе.
// Использует нативный модуль uiohook-napi (необязательная зависимость).
// Если модуль недоступен, PTT работает только при активном окне (обрабатывается в renderer).
import type { PttBinding } from './shared';

type Hook = {
  on(event: 'keydown' | 'keyup', cb: (e: { keycode: number }) => void): void;
  on(event: 'mousedown' | 'mouseup', cb: (e: { button: number }) => void): void;
  start(): void;
  stop(): void;
};

let hook: Hook | null = null;
let keys: Record<string, number> = {};
let started = false;
let target: { kind: 'key'; code: number } | { kind: 'mouse'; button: number } | null = null;
let pressed = false;
let emit: (pressed: boolean) => void = () => {};

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('uiohook-napi');
  hook = mod.uIOhook as Hook;
  keys = mod.UiohookKey as Record<string, number>;
} catch {
  hook = null;
}

export function globalPttAvailable(): boolean {
  return hook !== null;
}

function domCodeToHookName(code: string): string | null {
  let m: RegExpMatchArray | null;
  if ((m = code.match(/^Key([A-Z])$/))) return m[1];
  if ((m = code.match(/^Digit([0-9])$/))) return m[1];
  if (/^F\d{1,2}$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return code;
  const map: Record<string, string> = {
    ControlLeft: 'Ctrl', ControlRight: 'CtrlRight', ShiftLeft: 'Shift', ShiftRight: 'ShiftRight',
    AltLeft: 'Alt', AltRight: 'AltRight',
  };
  return map[code] ?? code;
}

function set(next: boolean) {
  if (next === pressed) return;
  pressed = next;
  emit(next);
}

export function initPtt(onChange: (pressed: boolean) => void): void {
  emit = onChange;
  if (!hook) return;
  hook.on('keydown', (e) => {
    if (target?.kind === 'key' && e.keycode === target.code) set(true);
  });
  hook.on('keyup', (e) => {
    if (target?.kind === 'key' && e.keycode === target.code) set(false);
  });
  hook.on('mousedown', (e) => {
    if (target?.kind === 'mouse' && e.button === target.button) set(true);
  });
  hook.on('mouseup', (e) => {
    if (target?.kind === 'mouse' && e.button === target.button) set(false);
  });
}

export function setPttBinding(binding: PttBinding | null): void {
  set(false);
  target = null;
  if (!hook || !binding) {
    stopHook();
    return;
  }
  const mouse = binding.code.match(/^Mouse([345])$/);
  if (mouse) {
    target = { kind: 'mouse', button: Number(mouse[1]) };
  } else {
    const name = domCodeToHookName(binding.code);
    const code = name ? keys[name] : undefined;
    if (typeof code === 'number') target = { kind: 'key', code };
  }
  if (target && !started) {
    try {
      hook.start();
      started = true;
    } catch {
      target = null;
    }
  } else if (!target) {
    stopHook();
  }
}

export function stopHook(): void {
  if (hook && started) {
    try {
      hook.stop();
    } catch {
      /* ignore */
    }
    started = false;
  }
}
