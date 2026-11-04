// Preload работает в изолированном мире (contextIsolation) и песочнице (sandbox).
// Наружу отдаётся только узкий типизированный API — без прямого доступа к ipcRenderer.
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { AppSettings, DeepLink, RvBridge, ScreenSource, UpdateState } from './shared';

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
};

contextBridge.exposeInMainWorld('rv', bridge);
