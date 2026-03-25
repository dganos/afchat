const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronLogs', {
  onLog: (callback) => {
    ipcRenderer.on('log', (_event, source, text) => callback(source, text))
  }
})
