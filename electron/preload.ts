// Preload работает в изолированном мире (contextIsolation) и песочнице (sandbox).
// Наружу отдаётся только узкий типизированный API — без прямого доступа к ipcRenderer.
import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron';
import type {
  AppSettings, DeepLink, DownloadProgress, NetReport, PickedItem, PowerEvent, RvBridge, ScreenSource, TransferProgress, UpdateState,
} from './shared';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const bridge: RvBridge = {
  platform: process.platform,
  storage: {
    getItem: (key) => ipcRenderer.invoke('storage:get', key) as Promise<string | null>,
    setItem: (key, value) => ipcRenderer.invoke('storage:set', key, value) as Promise<void>,
    removeItem: (key) => ipcRenderer.invoke('storage:remove', key) as Promise<void>,
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:version'),
    getSettings: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
    setSettings: (patch) => ipcRenderer.invoke('settings:set', patch) as Promise<AppSettings>,
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url) as Promise<void>,
    download: (url, filename) => ipcRenderer.invoke('app:download', url, filename) as Promise<void>,
    focus: () => ipcRenderer.send('app:focus'),
    flashFrame: () => ipcRenderer.send('app:flash'),
    setBadge: (count) => ipcRenderer.send('app:badge', count),
    consumeDeepLink: () => ipcRenderer.invoke('deeplink:consume') as Promise<DeepLink | null>,
    onDeepLink: (cb) => subscribe<DeepLink>('deeplink', cb),
    onHotkey: (cb) => subscribe<'toggleMute' | 'toggleDeafen'>('hotkey', cb),
    onPower: (cb) => subscribe<PowerEvent>('power', cb),
    diagnoseNetwork: (serverUrl, apiKey) => ipcRenderer.invoke('net:diagnose', serverUrl, apiKey) as Promise<NetReport>,
    quit: () => ipcRenderer.send('app:quit'),
  },
  screen: {
    getSources: () => ipcRenderer.invoke('screen:sources') as Promise<ScreenSource[]>,
    select: (id, withAudio) => ipcRenderer.invoke('screen:select', id, withAudio) as Promise<void>,
  },
  ptt: {
    isGlobalAvailable: () => ipcRenderer.invoke('ptt:available') as Promise<boolean>,
    setActive: (active) => ipcRenderer.send('ptt:active', active),
    onState: (cb) => subscribe<boolean>('ptt:state', cb),
  },
  updates: {
    getState: () => ipcRenderer.invoke('updates:get') as Promise<UpdateState | null>,
    check: () => ipcRenderer.invoke('updates:check') as Promise<void>,
    download: () => ipcRenderer.invoke('updates:download') as Promise<void>,
    install: () => ipcRenderer.invoke('updates:install') as Promise<boolean>,
    setInCall: (inCall) => ipcRenderer.send('updates:in-call', inCall),
    onState: (cb) => subscribe<UpdateState>('updates:state', cb),
  },
  files: {
    pickFiles: () => ipcRenderer.invoke('files:pick') as Promise<PickedItem[]>,
    pickFolder: () => ipcRenderer.invoke('files:pick-folder') as Promise<PickedItem | null>,
    // Путь можно получить только у настоящего File из события drop/input — подделать его из страницы нельзя
    registerDropped: (files) => {
      const paths = Array.from(files)
        .slice(0, 10)
        .map((f) => {
          try {
            return webUtils.getPathForFile(f);
          } catch {
            return '';
          }
        })
        .filter(Boolean);
      return ipcRenderer.invoke('files:register-dropped', paths) as Promise<PickedItem[]>;
    },
    release: (tokens) => ipcRenderer.invoke('files:release', tokens) as Promise<void>,
    prepare: (id, token, maxBytes) => ipcRenderer.invoke('files:prepare', id, token, maxBytes) as Promise<{ size: number; contentType: string }>,
    upload: (req) => ipcRenderer.invoke('files:upload', req) as Promise<void>,
    pause: (id) => ipcRenderer.invoke('files:pause', id) as Promise<void>,
    cancel: (id) => ipcRenderer.invoke('files:cancel', id) as Promise<void>,
    onUploadProgress: (cb) => subscribe<TransferProgress>('files:upload-progress', cb),
    download: (req) => ipcRenderer.invoke('files:download', req) as Promise<void>,
    cancelDownload: (id) => ipcRenderer.invoke('files:cancel-download', id) as Promise<void>,
    onDownloadProgress: (cb) => subscribe<DownloadProgress>('files:download-progress', cb),
    showInFolder: (p) => ipcRenderer.invoke('files:show', p) as Promise<void>,
    openDownloaded: (p, confirmed) => ipcRenderer.invoke('files:open', p, confirmed) as Promise<'opened' | 'needs-confirmation' | 'missing'>,
  },
};

contextBridge.exposeInMainWorld('rv', bridge);
