const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('erbHost', {
  getSave: () => ipcRenderer.invoke('erb-get-save'),
  applySave: text => ipcRenderer.invoke('erb-apply-save', String(text)),
  getStats: () => ipcRenderer.invoke('erb-get-stats'),
});
