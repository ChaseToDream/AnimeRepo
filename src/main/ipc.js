// IPC 处理器：注册所有渲染进程可调用的通道
import { ipcMain, dialog, app, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import * as store from './store'
import { scanLibrary, rebuildDatabase } from './scanner'

const SUBTITLE_EXTS = ['.srt', '.ass', '.ssa', '.vtt', '.sub']

export function registerIpc() {
  // —— 番剧库 ——
  ipcMain.handle('library:get', () => store.list())
  ipcMain.handle('library:get-one', (_e, id) => store.get(id))
  ipcMain.handle('library:scan', async () => {
    const settings = store.getSettings()
    return scanLibrary(store, settings.libraryFolders || [], settings)
  })
  ipcMain.handle('anime:update', (_e, id, patch) => store.updateAnime(id, patch))
  ipcMain.handle('anime:remove', (_e, id) => store.remove(id))
  ipcMain.handle('anime:set-progress', (_e, animeId, epId, seconds, duration) =>
    store.setEpisodeProgress(animeId, epId, seconds, duration)
  )
  ipcMain.handle('anime:set-watched', (_e, animeId, epId, watched) =>
    store.setEpisodeWatched(animeId, epId, watched)
  )

  // —— 设置 ——
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:update', (_e, patch) => store.updateSettings(patch))
  ipcMain.handle('settings:add-folder', async (_e) => {
    const settings = store.getSettings()
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths.length) return settings.libraryFolders
    const folder = res.filePaths[0]
    if (!settings.libraryFolders.includes(folder)) {
      settings.libraryFolders.push(folder)
      store.updateSettings({ libraryFolders: settings.libraryFolders })
    }
    return store.getSettings().libraryFolders
  })
  ipcMain.handle('settings:remove-folder', (_e, folder) => {
    const settings = store.getSettings()
    const folders = settings.libraryFolders.filter((f) => f !== folder)
    store.updateSettings({ libraryFolders: folders })
    return folders
  })
  ipcMain.handle('dialog:select-folder', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0]
  })

  // —— 数据管理 ——
  ipcMain.handle('data:export', async () => {
    const res = await dialog.showSaveDialog({ defaultPath: 'animerepo-backup.json' })
    if (res.canceled || !res.filePath) return false
    fs.writeFileSync(res.filePath, JSON.stringify({ animes: store.list(), settings: store.getSettings() }, null, 2), 'utf-8')
    return true
  })
  ipcMain.handle('data:import', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (res.canceled || !res.filePaths.length) return false
    const raw = fs.readFileSync(res.filePaths[0], 'utf-8')
    return store.importJson(raw)
  })
  ipcMain.handle('data:rebuild', async () => {
    const settings = store.getSettings()
    return rebuildDatabase(store, settings.libraryFolders || [], settings)
  })
  ipcMain.handle('data:reset', () => {
    store.reset()
    return true
  })

  // —— 系统 ——
  ipcMain.handle('shell:open-folder', (_e, p) => {
    if (p && fs.existsSync(p)) shell.openPath(p)
  })
  ipcMain.handle('app:version', () => app.getVersion())

  // —— 字幕 ——
  ipcMain.handle('subtitle:read', (_e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return null
      if (!SUBTITLE_EXTS.includes(path.extname(filePath).toLowerCase())) return null
      return fs.readFileSync(filePath, 'utf-8')
    } catch (e) {
      return null
    }
  })

  // —— 窗口控制 ——
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
}