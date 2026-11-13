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

export type PowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen' | 'user-idle' | 'user-active';

// ---------- Диагностика подключения ----------

export interface NetCheck {
  id: string;
  label: string;
  ok: boolean;
  ms: number;
  detail: string | null;
}

export interface NetReport {
  at: string;
  appVersion: string;
  platform: string;
  host: string;
  proxy: string | null;
  verdict: import('./netVerdict').NetVerdict;
  facts: import('./netVerdict').NetFacts;
  checks: NetCheck[];
}

// ---------- Передача файлов ----------

/** Файл или папка, выбранные пользователем; путь на диске остаётся в main-процессе */
export interface PickedItem {
  token: string;
  kind: 'file' | 'folder';
  name: string;
  /** Размер файла; для папки — суммарный размер файлов до сжатия */
  size: number;
  /** Для папки: число файлов и пустых папок */
  files?: number;
  dirs?: number;
  /** Причина, по которой элемент нельзя отправить (слишком большой и т.п.) */
  error?: string | null;
}

export interface UploadRequest {
  /** Идентификатор задачи, выбирает renderer */
  id: string;
  token: string;
  /** Конечная точка TUS Supabase Storage и путь объекта, выданный сервером (reserve_attachment) */
  endpoint: string;
  bucket: string;
  objectPath: string;
  contentType: string;
  accessToken: string;
  apiKey: string;
  /** Максимальный размер отправляемого файла (после сжатия папки) */
  maxBytes: number;
}

export type TransferPhase = 'preparing' | 'uploading' | 'paused' | 'waiting-network' | 'done' | 'error' | 'cancelled';

export interface TransferProgress {
  id: string;
  phase: TransferPhase;
  /** Подготовка папки: сколько файлов уже упаковано */
  packedFiles?: number;
  totalFiles?: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  error?: string | null;
  /** Итог: размер отправленного объекта и тип */
  result?: { size: number; contentType: string; sha256?: string } | null;
}

export interface DownloadRequest {
  id: string;
  url: string;
  name: string;
  /** zip-архив папки: распаковать в выбранную папку с сохранением структуры */
  extractFolder: boolean;
  size: number;
}

export interface DownloadProgress {
  id: string;
  phase: 'choosing' | 'downloading' | 'extracting' | 'done' | 'error' | 'cancelled';
  transferred: number;
  total: number;
  bytesPerSecond: number;
  savedPath?: string | null;
  error?: string | null;
}

export interface FilesBridge {
  /** Окно выбора файлов (несколько) */
  pickFiles(): Promise<PickedItem[]>;
  /** Окно выбора папки */
  pickFolder(): Promise<PickedItem | null>;
  /** Перетащенные в окно файлы и папки (объекты File из события drop) */
  registerDropped(files: File[]): Promise<PickedItem[]>;
  release(tokens: string[]): Promise<void>;
  /** Проверить файл или упаковать папку в ZIP; возвращает размер того, что будет отправлено */
  prepare(id: string, token: string, maxBytes: number): Promise<{ size: number; contentType: string }>;
  /** Начать или продолжить (после паузы/обрыва) загрузку; завершается, когда файл принят сервером */
  upload(req: UploadRequest): Promise<void>;
  /** Приостановить (отменить с сохранением прогресса) / отменить загрузку */
  pause(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  onUploadProgress(cb: (p: TransferProgress) => void): () => void;
  download(req: DownloadRequest): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  onDownloadProgress(cb: (p: DownloadProgress) => void): () => void;
  showInFolder(path: string): Promise<void>;
  /** Открыть скачанный файл; для потенциально опасных типов возвращает false без открытия, если нет подтверждения */
  openDownloaded(path: string, confirmedDangerous: boolean): Promise<'opened' | 'needs-confirmation' | 'missing'>;
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
    /** Сон/пробуждение Windows и блокировка экрана */
    onPower(cb: (event: PowerEvent) => void): () => void;
    /** Пошаговая проверка пути до сервера (интернет, DNS, TLS, прокси, WebSocket, часы) */
    diagnoseNetwork(serverUrl: string, apiKey: string): Promise<NetReport>;
    quit(): void;
  };
  files: FilesBridge;
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
