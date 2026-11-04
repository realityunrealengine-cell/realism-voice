import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, PttBinding } from './shared';

const DEFAULTS: AppSettings = {
  autostart: false,
  startMinimized: false,
  minimizeToTray: false,
  closeToTray: true,
  hardwareAcceleration: true,
  hotkeys: {
    toggleMute: 'Ctrl+Shift+M',
    toggleDeafen: 'Ctrl+Shift+D',
  },
  ptt: null,
};

const ACCELERATOR_RE = /^((Ctrl|Control|Alt|Shift|Super|CommandOrControl|CmdOrCtrl)\+){0,3}[A-Za-z0-9]$|^((Ctrl|Control|Alt|Shift|Super|CommandOrControl|CmdOrCtrl)\+){0,3}(F[1-9]|F1[0-9]|F2[0-4]|Space|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|num[0-9])$|^$/;
const PTT_CODE_RE = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Numpad[0-9]|Mouse[345]|ControlLeft|ControlRight|ShiftLeft|ShiftRight|AltLeft|AltRight|Space|Backquote|CapsLock|Tab|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Insert|Delete|Home|End|PageUp|PageDown)$/;

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

let cache: AppSettings | null = null;

export function loadSettings(): AppSettings {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = sanitize({ ...DEFAULTS, ...raw, hotkeys: { ...DEFAULTS.hotkeys, ...(raw?.hotkeys ?? {}) } });
  } catch {
    cache = { ...DEFAULTS, hotkeys: { ...DEFAULTS.hotkeys } };
  }
  return cache;
}

function sanitizePtt(v: unknown): PttBinding | null {
  if (!v || typeof v !== 'object') return null;
  const { code, label } = v as Record<string, unknown>;
  if (typeof code !== 'string' || !PTT_CODE_RE.test(code)) return null;
  return { code, label: typeof label === 'string' ? label.slice(0, 32) : code };
}

function sanitize(s: AppSettings): AppSettings {
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const accel = (v: unknown, d: string) => (typeof v === 'string' && ACCELERATOR_RE.test(v) ? v : d);
  return {
    autostart: bool(s.autostart, DEFAULTS.autostart),
    startMinimized: bool(s.startMinimized, DEFAULTS.startMinimized),
    minimizeToTray: bool(s.minimizeToTray, DEFAULTS.minimizeToTray),
    closeToTray: bool(s.closeToTray, DEFAULTS.closeToTray),
    hardwareAcceleration: bool(s.hardwareAcceleration, DEFAULTS.hardwareAcceleration),
    hotkeys: {
      toggleMute: accel(s.hotkeys?.toggleMute, DEFAULTS.hotkeys.toggleMute),
      toggleDeafen: accel(s.hotkeys?.toggleDeafen, DEFAULTS.hotkeys.toggleDeafen),
    },
    ptt: sanitizePtt(s.ptt),
  };
}

export function updateSettings(patch: unknown): AppSettings {
  const current = loadSettings();
  if (!patch || typeof patch !== 'object') return current;
  const p = patch as Partial<AppSettings>;
  const next = sanitize({
    ...current,
    ...p,
    hotkeys: { ...current.hotkeys, ...(p.hotkeys ?? {}) },
    ptt: 'ptt' in p ? (p.ptt ?? null) : current.ptt,
  });
  cache = next;
  const tmp = file() + '.tmp';
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file());
  return next;
}
