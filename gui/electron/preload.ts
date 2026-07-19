// Preload script — exposes safe IPC API to renderer
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aicut', {
  render: (json: string) => ipcRenderer.invoke('engine:render', json),
  probe: (path: string) => ipcRenderer.invoke('engine:probe', path),
  getPresets: () => ipcRenderer.invoke('engine:presets'),
  getVersion: () => ipcRenderer.invoke('engine:version'),
  validate: (json: string) => ipcRenderer.invoke('engine:validate', json),
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  saveProject: (path: string, content: string) => ipcRenderer.invoke('file:saveProject', path, content),
  loadProject: (path: string) => ipcRenderer.invoke('file:loadProject', path),
});
