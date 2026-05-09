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
  readSharedRuns: () => ipcRenderer.invoke('read-shared-runs'),

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

  // Kernel bundle (for historical save reconstruction)
  getKernelsBundle: () => ipcRenderer.invoke('get-kernels-bundle'),
  syncKernelsFromRemote:  () => ipcRenderer.invoke('sync-kernels-from-remote'),
  syncMapIconsFromRemote: () => ipcRenderer.invoke('sync-map-icons-from-remote'),

  // Open Chromium DevTools detached. Useful for inspecting card-render
  // hydration, the kernel composer, network calls, etc.
  openDevTools: () => ipcRenderer.invoke('open-devtools'),

  // Local extraction (Phase 2)
  detectSts2Install:   (customSteamPath) => ipcRenderer.invoke('detect-sts2-install', customSteamPath),
  toolsDetectAll:      ()                => ipcRenderer.invoke('tools-detect-all'),
  toolsFetchRelease:   (name)            => ipcRenderer.invoke('tools-fetch-release', name),
  toolsInstall:        (name)            => ipcRenderer.invoke('tools-install', name),
  onToolsInstallProgress: (callback) => ipcRenderer.on('tools-install-progress', (_e, msg) => callback(msg)),
  removeToolsInstallListeners: () => ipcRenderer.removeAllListeners('tools-install-progress'),

  // Resource updater
  checkDataExists: () => ipcRenderer.invoke('check-data-exists'),
  getResourceMeta: () => ipcRenderer.invoke('get-resource-meta'),
  setResourceMeta: (data) => ipcRenderer.invoke('set-resource-meta', data),
  runUpdateResources: () => ipcRenderer.invoke('run-update-resources'),
  cancelUpdate: () => ipcRenderer.invoke('cancel-update'),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (_e, msg) => callback(msg)),
  removeUpdateListeners: () => ipcRenderer.removeAllListeners('update-progress'),

  // Card-shell cache (Strategy B): pre-rendered frame/border/banner/plaque
  // shells per (character, type, rarity) so runtime card renders skip the
  // heavy HSV pixel pipeline.
  listCardShells:  ()             => ipcRenderer.invoke('list-card-shells'),
  saveCardShell:   (key, base64)  => ipcRenderer.invoke('save-card-shell', key, base64),
  clearCardShells: ()             => ipcRenderer.invoke('clear-card-shells'),

  // Full card PNG cache (Strategy A): pre-rendered card images per
  // (character, name, base|upgraded[, Mad Science rider]). Runtime
  // hydration loads these directly via appdata:// — no canvas at all.
  listCardPngs:  ()             => ipcRenderer.invoke('list-card-pngs'),
  saveCardPng:   (key, base64)  => ipcRenderer.invoke('save-card-png', key, base64),
  clearCardPngs: ()             => ipcRenderer.invoke('clear-card-pngs'),

  // Pipeline render stage. Main triggers the bake by sending
  // `pipeline-bake-cards-trigger`; the helper does the work and reports
  // progress + completion back the same way.
  onPipelineBakeTrigger: (cb)        => ipcRenderer.on('pipeline-bake-cards-trigger', cb),
  notifyBakeProgress:    (progress)  => ipcRenderer.send('pipeline-bake-cards-progress', progress),
  notifyBakeDone:        (result)    => ipcRenderer.send('pipeline-bake-cards-done', result),
});
