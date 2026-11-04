// Типы, общие для main, preload и renderer. Только типы — без кода выполнения.

export interface AppSettings {
  autostart: boolean;
  startMinimized: boolean;
  minimizeToTray: boolean;
  closeToTray: boolean;
  hardwareAcceleration: boolean;
  hotkeys: {
    toggleMute: string;
    toggleDeafen: string;
  };
  ptt: PttBinding | null;
}

export interface PttBinding {
  /** Код клавиши DOM (KeyboardEvent.code), например "KeyV", или "Mouse4"/"Mouse5" */
  code: string;
  label: string;
}

export interface ScreenSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string;
  appIcon: string | null;
}

export type DeepLink =
  | { type: 'auth'; action: 'callback' | 'reset'; code: string | null; error: string | null; errorDescription: string | null }
  | { type: 'invite'; code: string };

export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'not-available' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';

export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdateState {
  phase: UpdatePhase;
  /** Почему обновления недоступны: не установленная сборка, канал не настроен или модуль не запустился */
  disabledReason: 'dev' | 'unconfigured' | 'failed' | null;
  currentVersion: string;
  availableVersion: string | null;
  releaseNotes: string | null;
  progress: UpdateProgress | null;
  error: string | null;
  lastCheckedAt: number | null;
  nextRetryAt: number | null;
  /** В сборке указан издатель: кроме SHA-512 проверяется цифровая подпись обновления */
  signatureRequired: boolean;
}

export interface RvBridge {
  platform: string;
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  };
  app: {
    getVersion(): Promise<{ app: string; electron: string; chrome: string; node: string }>;
    getSettings(): Promise<AppSettings>;
    setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
    openExternal(url: string): Promise<void>;
    download(url: string, filename: string): Promise<void>;
    focus(): void;
    flashFrame(): void;
    setBadge(count: number): void;
    consumeDeepLink(): Promise<DeepLink | null>;
    onDeepLink(cb: (link: DeepLink) => void): () => void;
    onHotkey(cb: (action: 'toggleMute' | 'toggleDeafen') => void): () => void;
    quit(): void;
  };
  screen: {
    getSources(): Promise<ScreenSource[]>;
    select(id: string | null, withAudio: boolean): Promise<void>;
  };
  ptt: {
    isGlobalAvailable(): Promise<boolean>;
    /** Глобальный перехват клавиш включается только на время голосового подключения с режимом PTT */
    setActive(active: boolean): void;
    onState(cb: (pressed: boolean) => void): () => void;
  };
  updates: {
    getState(): Promise<UpdateState | null>;
    check(): Promise<void>;
    download(): Promise<void>;
    /** false — установка сейчас невозможна (идёт звонок или обновление не готово) */
    install(): Promise<boolean>;
    setInCall(inCall: boolean): void;
    onState(cb: (state: UpdateState) => void): () => void;
  };
}
