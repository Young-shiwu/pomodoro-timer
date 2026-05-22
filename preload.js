const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pomodoro', {
  notify: (title, body) => ipcRenderer.invoke('notify', { title, body }),
  updateTrayTitle: (text) => ipcRenderer.invoke('update-tray-title', { text }),
  onTrayAction: (callback) => {
    ipcRenderer.removeAllListeners('tray-action');
    ipcRenderer.on('tray-action', (event, payload) => callback(payload));
  },
});
