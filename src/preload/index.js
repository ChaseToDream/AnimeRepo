import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 构造一个安全的数据文件访问 URL（由主进程 anime:// 协议处理）
function toVideoUrl(filePath) {
  if (!filePath) return ''
  return 'anime://local/' + Buffer.from(filePath, 'utf-8').toString('base64url')
}

const api = {
  platform: process.platform,
  toVideoUrl,
  // —— 番剧库 ——
  getLibrary: () => ipcRenderer.invoke('library:get'),
  getAnime: (id) => ipcRenderer.invoke('library:get-one', id),
  scanLibrary: () => ipcRenderer.invoke('library:scan'),
  // 订阅扫描进度事件，返回取消订阅函数
  onScanProgress: (cb) => {
    const listener = (_e, info) => cb(info)
    ipcRenderer.on('scan:progress', listener)
    return () => ipcRenderer.removeListener('scan:progress', listener)
  },
  updateAnime: (id, patch) => ipcRenderer.invoke('anime:update', id, patch),
  removeAnime: (id) => ipcRenderer.invoke('anime:remove', id),
  batchAnime: (op) => ipcRenderer.invoke('anime:batch', op),
  mergeAnime: (fromId, toId) => ipcRenderer.invoke('anime:merge', fromId, toId),
  splitAnime: (fromId, epIds, newTitle) => ipcRenderer.invoke('anime:split', fromId, epIds, newTitle),
  setProgress: (animeId, epId, seconds, duration) =>
    ipcRenderer.invoke('anime:set-progress', animeId, epId, seconds, duration),
  setWatched: (animeId, epId, watched) => ipcRenderer.invoke('anime:set-watched', animeId, epId, watched),
  // —— 设置 ——
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  addLibraryFolder: () => ipcRenderer.invoke('settings:add-folder'),
  removeLibraryFolder: (folder) => ipcRenderer.invoke('settings:remove-folder', folder),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  // —— 数据管理 ——
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),
  rebuildDatabase: () => ipcRenderer.invoke('data:rebuild'),
  resetData: () => ipcRenderer.invoke('data:reset'),
  // —— 系统 ——
  openFolder: (p) => ipcRenderer.invoke('shell:open-folder', p),
  getVersion: () => ipcRenderer.invoke('app:version'),
  // —— 字幕 ——
  readSubtitle: (filePath) => ipcRenderer.invoke('subtitle:read', filePath),
  // —— 窗口控制 ——
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}