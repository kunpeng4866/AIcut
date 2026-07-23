// Preload script — exposes safe IPC API to renderer
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aicut', {
  // ── 引擎 ──
  render: (json: string) => ipcRenderer.invoke('engine:render', json),
  probe: (path: string) => ipcRenderer.invoke('engine:probe', path),
  getPresets: () => ipcRenderer.invoke('engine:presets'),
  getVersion: () => ipcRenderer.invoke('engine:version'),
  validate: (json: string) => ipcRenderer.invoke('engine:validate', json),

  // ── 文件 ──
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  saveProject: (path: string, content: string) => ipcRenderer.invoke('file:saveProject', path, content),
  loadProject: (path: string) => ipcRenderer.invoke('file:loadProject', path),
  openSaveDialog: (defaultName?: string) => ipcRenderer.invoke('dialog:saveFile', defaultName),

  // ── AI配置 ──
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (json: string) => ipcRenderer.invoke('config:set', json),

  // ── 插件 ──
  listPlugins: () => ipcRenderer.invoke('plugin:list'),
  scanPlugins: () => ipcRenderer.invoke('plugin:scan'),
  buildPluginFilter: (pluginId: string, params: string) => ipcRenderer.invoke('plugin:buildFilter', pluginId, params),

  // ── 导出 ──
  exportVideo: (command: string, outputPath: string) => ipcRenderer.invoke('render:export', command, outputPath),
  openExportDialog: (defaultName?: string) => ipcRenderer.invoke('dialog:exportFile', defaultName),
  export: {
    start: (project: any, outputPath: string, options: any) =>
      ipcRenderer.invoke('export:start', { project, outputPath, options }),
    onProgress: (callback: (progress: number) => void) => {
      ipcRenderer.removeAllListeners('export:progress');
      ipcRenderer.on('export:progress', (_, progress: number) => callback(progress));
    },
    onDone: (callback: () => void) => {
      ipcRenderer.removeAllListeners('export:done');
      ipcRenderer.on('export:done', () => callback());
    },
    onError: (callback: (err: string) => void) => {
      ipcRenderer.removeAllListeners('export:error');
      ipcRenderer.on('export:error', (_, err: string) => callback(err));
    },
    cancel: () => ipcRenderer.invoke('export:cancel'),
    openFolder: (filePath: string) => ipcRenderer.invoke('export:openFolder', filePath),
  },

  // ── TTS 语音合成 ──
  ttsSynthesize: (text: string, voice: string, outputPath: string) =>
    ipcRenderer.invoke('tts:synthesize', text, voice, outputPath),
  ttsVoices: () => ipcRenderer.invoke('tts:voices'),

  // ── AI 自动字幕 ──
  ai: {
    generateSubtitles: (transcript: string, lang: string) =>
      ipcRenderer.invoke('ai:generateSubtitles', transcript, lang),
  },

  // ── ASR 本地语音转写 ──
  asr: {
    transcribe: (audioPath: string, lang: string) =>
      ipcRenderer.invoke('asr:transcribe', audioPath, lang),
  },

  // ── 草稿 ──
  saveDraft: (name: string, content: string) => ipcRenderer.invoke('draft:save', name, content),
  loadDraft: (name: string) => ipcRenderer.invoke('draft:load', name),
  listDrafts: () => ipcRenderer.invoke('draft:list'),
  deleteDraft: (name: string) => ipcRenderer.invoke('draft:delete', name),
});
