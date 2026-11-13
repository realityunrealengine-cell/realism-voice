const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smoke', {
  invoke: (user, body) => ipcRenderer.invoke('invoke', user, body),
  log: (msg) => ipcRenderer.send('log', String(msg)),
  done: (ok) => ipcRenderer.send('done', !!ok),
});
