'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listNotes:        ()             => ipcRenderer.invoke('list-notes'),
  readNote:         (file)         => ipcRenderer.invoke('read-note', file),
  saveKernel:       (file, kernel) => ipcRenderer.invoke('save-kernel', file, kernel),
  paths:            ()             => ipcRenderer.invoke('paths'),
  lookup:           (query, limit) => ipcRenderer.invoke('lookup', query, limit),
  llmSuggestNew:    (opts)         => ipcRenderer.invoke('llm-suggest-new', opts),
});
