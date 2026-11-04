// Хранилище сессии Supabase. Токены шифруются через safeStorage
// (на Windows — DPAPI, привязка к учётной записи пользователя ОС)
// и никогда не попадают в localStorage renderer-процесса.
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_VALUE = 512 * 1024;
const MAX_KEYS = 32;

let data: Record<string, string> | null = null;

function file(): string {
  return path.join(app.getPath('userData'), 'session.bin');
}

function load(): Record<string, string> {
  if (data) return data;
  data = {};
  try {
    const buf = fs.readFileSync(file());
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : '';
    const parsed = json ? JSON.parse(json) : {};
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (KEY_RE.test(k) && typeof v === 'string') data[k] = v;
      }
    }
  } catch {
    data = {};
  }
  return data;
}

function persist(): void {
  if (!data) return;
  // Без шифрования сессия не сохраняется на диск (остаётся только в памяти).
  if (!safeStorage.isEncryptionAvailable()) return;
  const buf = safeStorage.encryptString(JSON.stringify(data));
  const tmp = file() + '.tmp';
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file());
}

export function validKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_RE.test(key);
}

export function getItem(key: string): string | null {
  return load()[key] ?? null;
}

export function setItem(key: string, value: unknown): void {
  if (typeof value !== 'string' || value.length > MAX_VALUE) throw new Error('invalid value');
  const d = load();
  if (!(key in d) && Object.keys(d).length >= MAX_KEYS) throw new Error('too many keys');
  d[key] = value;
  persist();
}

export function removeItem(key: string): void {
  const d = load();
  if (key in d) {
    delete d[key];
    persist();
  }
}
