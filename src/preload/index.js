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
  // UX-03：取消当前手动扫描
  cancelScan: () => ipcRenderer.send('scan:cancel'),
  // 订阅扫描进度事件，返回取消订阅函数
  onScanProgress: (cb) => {
    const listener = (_e, info) => cb(info)
    ipcRenderer.on('scan:progress', listener)
    return () => ipcRenderer.removeListener('scan:progress', listener)
  },
  // PF-02：订阅后台扫描的库变更增量事件，返回取消订阅函数
  onLibraryChanged: (cb) => {
    const listener = (_e, delta) => cb(delta)
    ipcRenderer.on('library:changed', listener)
    return () => ipcRenderer.removeListener('library:changed', listener)
  },
  // UX-08：订阅通知点击导航事件，返回取消订阅函数
  onNavigate: (cb) => {
    const listener = (_e, path) => cb(path)
    ipcRenderer.on('app:navigate', listener)
    return () => ipcRenderer.removeListener('app:navigate', listener)
  },
  // O-04：观看历史
  getWatchHistory: () => ipcRenderer.invoke('history:get'),
  // N-01：追番日历
  fetchCalendar: () => ipcRenderer.invoke('calendar:fetch'),
  updateAnime: (id, patch) => ipcRenderer.invoke('anime:update', id, patch),
  removeAnime: (id) => ipcRenderer.invoke('anime:remove', id),
  // F-7：手动添加“想看”占位条目
  createAnime: (title) => ipcRenderer.invoke('anime:create', title),
  batchAnime: (op) => ipcRenderer.invoke('anime:batch', op),
  // F-9：标签管理（合并/重命名/删除）
  replaceTag: (oldTag, newTag) => ipcRenderer.invoke('anime:replace-tag', oldTag, newTag),
  removeTag: (tag) => ipcRenderer.invoke('anime:remove-tag', tag),
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
  // UX-14：数据文件最后修改时间
  getDataLastSaved: () => ipcRenderer.invoke('data:last-saved'),
  // —— 系统 ——
  openFolder: (p) => ipcRenderer.invoke('shell:open-folder', p),
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  // N-5：打开项目 LICENSE 文件
  openLicense: () => ipcRenderer.invoke('app:open-license'),
  // —— B-7：更新源是否已配置（未配置时不展示检查更新入口）
  hasUpdateSource: () => ipcRenderer.invoke('app:has-update-source'),
  // —— F-4：局域网播放 ——
  getWebInfo: () => ipcRenderer.invoke('web:get-info'),
  setWebServerEnabled: (enabled) => ipcRenderer.invoke('web:set-enabled', enabled),
  updateWebServerConfig: (patch) => ipcRenderer.invoke('web:update-config', patch),
  resetWebToken: () => ipcRenderer.invoke('web:reset-token'),
  // —— N-02：外部播放器 ——
  openExternalPlayer: (filePath) => ipcRenderer.invoke('player:open-external', filePath),
  pickExecutable: () => ipcRenderer.invoke('dialog:pick-executable'),
  // —— N-06：封面 ——
  pickImage: () => ipcRenderer.invoke('dialog:pick-image'),
  setAnimeCover: (id, filePath) => ipcRenderer.invoke('anime:set-cover', id, filePath),
  // —— O-2：在线元数据手动刷新 ——
  refreshAnimeMetadata: (id) => ipcRenderer.invoke('anime:refresh-metadata', id),
  // —— O-10：批量补全元数据（不传 ids 时自动选择缺失封面/简介的条目） ——
  batchRefreshMetadata: (ids) => ipcRenderer.invoke('anime:batch-refresh-metadata', ids),
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