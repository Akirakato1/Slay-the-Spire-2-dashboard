const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (data) => ipcRenderer.invoke('save-config', data),
  getAssetsPath: () => ipcRenderer.invoke('get-assets-path'),

  // Folder selection
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // Open a single .run file from disk
  openRunFile: () => ipcRenderer.invoke('open-run-file'),

  // Clipboard
  copyFile: (filePath) => ipcRenderer.invoke('copy-file', filePath),
  exportToPastebin: (filePath, apiKey) => ipcRenderer.invoke('export-to-pastebin', { filePath, apiKey }),
  fetchPastebin: (url) => ipcRenderer.invoke('fetch-pastebin', url),

  // Run file reading
  readRunFiles: (folderPath) => ipcRenderer.invoke('read-run-files', folderPath),

  // Navigation
  navigateToDashboard: () => ipcRenderer.invoke('navigate-to-dashboard'),
  navigateToSetup: () => ipcRenderer.invoke('navigate-to-setup'),

  // Favorites
  getFavorites: () => ipcRenderer.invoke('get-favorites'),
  toggleFavorite: (key) => ipcRenderer.invoke('toggle-favorite', key),

  // Watcher events
  onRunsChanged: (callback) => {
    ipcRenderer.on('runs-changed', callback);
  },
  removeRunsChangedListener: (callback) => {
    ipcRenderer.removeListener('runs-changed', callback);
  },

  // Resource updater
  checkDataExists: () => ipcRenderer.invoke('check-data-exists'),
  getResourceMeta: () => ipcRenderer.invoke('get-resource-meta'),
  setResourceMeta: (data) => ipcRenderer.invoke('set-resource-meta', data),
  runUpdateResources: () => ipcRenderer.invoke('run-update-resources'),
  cancelUpdate: () => ipcRenderer.invoke('cancel-update'),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (_e, msg) => callback(msg)),
  removeUpdateListeners: () => ipcRenderer.removeAllListeners('update-progress'),
});
