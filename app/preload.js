const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onModel: (cb) => ipcRenderer.on('model', (_e, body) => cb(body)),
  getLastModel: () => ipcRenderer.invoke('get-last-model'),
  fetchAsset: (ref, kind) => ipcRenderer.invoke('fetch-asset', ref, kind),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (s) => ipcRenderer.invoke('set-settings', s),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  savePng: (dataUrl, name) => ipcRenderer.invoke('save-png', dataUrl, name),
  copyPng: (dataUrl) => ipcRenderer.invoke('copy-png', dataUrl),
});
