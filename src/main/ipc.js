// IPC 处理器：注册所有渲染进程可调用的通道
import { ipcMain, dialog, app, shell, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import * as store from './store'
import { scanLibrary, rebuildDatabase } from './scanner'
import { titleKey } from './parser'

const SUBTITLE_EXTS = ['.srt', '.ass', '.ssa', '.vtt', '.sub']

// 扫描进度推送：向发起扫描的窗口发送 scan:progress 事件
// P2 修复：节流合并高频进度——大库扫描每发现一个文件都会触发一次进度，
// 若不节流将造成 IPC 洪泛 + 渲染进程高频 setState 全量重渲染，导致白屏卡死
function scanProgressSender(sender) {
  const win = BrowserWindow.fromWebContents(sender)
  let lastSent = 0
  let pending = null
  let timer = null
  const THROTTLE_MS = 100
  const flush = () => {
    timer = null
    if (!pending) return
    const info = pending
    pending = null
    if (win && !win.isDestroyed()) win.webContents.send('scan:progress', info)
  }
  return (info) => {
    if (!win || win.isDestroyed()) return
    pending = info
    if (timer) return
    const now = Date.now()
    const wait = Math.max(0, THROTTLE_MS - (now - lastSent))
    if (wait === 0) {
      lastSent = now
      flush()
    } else {
      timer = setTimeout(() => {
        lastSent = Date.now()
        flush()
      }, wait)
    }
  }
}

export function registerIpc() {
  // —— 番剧库 ——
  ipcMain.handle('library:get', () => store.list())
  ipcMain.handle('library:get-one', (_e, id) => store.get(id))
  ipcMain.handle('library:scan', async (e) => {
    const settings = store.getSettings()
    return scanLibrary(store, settings.libraryFolders || [], settings, scanProgressSender(e.sender))
  })
  ipcMain.handle('anime:update', (_e, id, patch) => store.updateAnime(id, patch))
  ipcMain.handle('anime:remove', (_e, id) => store.remove(id))
  // —— 批量操作（N4）——
  ipcMain.handle('anime:batch', (_e, { action, ids, payload }) => {
    const targets = (ids || []).map((id) => store.get(id)).filter(Boolean)
    if (!targets.length) return store.list()
    switch (action) {
      case 'remove':
        for (const a of targets) store.remove(a.id)
        break
      case 'set-status': {
        const status = payload && payload.status
        if (status) for (const a of targets) store.updateAnime(a.id, { status })
        break
      }
      case 'set-favorite': {
        const fav = Boolean(payload && payload.favorite)
        for (const a of targets) store.updateAnime(a.id, { isFavorite: fav })
        break
      }
      case 'mark-watched':
      case 'mark-unwatched': {
        // B5：批量标记改为单次落盘 + 单次状态重算，避免 N 集触发 N 次全量写盘
        const watched = action === 'mark-watched'
        for (const a of targets) {
          const epIds = (a.episodes || []).map((e) => e.id)
          store.setEpisodesWatchedBulk(a.id, epIds, watched)
        }
        break
      }
      case 'set-tags': {
        const tags = (payload && payload.tags) || []
        for (const a of targets) store.updateAnime(a.id, { tags })
        break
      }
      default:
        return store.list()
    }
    return store.list()
  })
  // —— 合并 / 拆分番剧（N3）——
  // 合并：把 from 的剧集追加到 to（集数冲突自动顺延），随后删除 from
  // B6：nextNum 单调递增分配冲突号，避免非连续编号下 while 循环导致编号漂移；
  // aired 取最终合并后的集数组长度（而非前值之和）。
  ipcMain.handle('anime:merge', (_e, fromId, toId) => {
    const from = store.get(fromId)
    const to = store.get(toId)
    if (!from || !to || fromId === toId) return store.list()
    const base = to.episodes || []
    const used = new Set(base.map((e) => e.number))
    let nextNum = Math.max(0, ...base.map((e) => e.number))
    const moved = (from.episodes || [])
      .slice()
      .sort((a, b) => a.number - b.number)
      .map((ep) => {
        let number = ep.number
        if (used.has(number)) {
          // 只对冲突号分配递增新号，已存在的原号保持不变
          nextNum += 1
          number = nextNum
        }
        used.add(number)
        return { ...ep, id: `${to.id}-ep${number}`, animeId: to.id, number }
      })
    const episodes = [...base, ...moved]
    store.updateAnime(to.id, { episodes, aired: episodes.length })
    store.remove(fromId)
    return store.list()
  })
  // 拆分：把指定剧集从 from 移出，创建为新番剧
  ipcMain.handle('anime:split', (_e, fromId, epIds, newTitle) => {
    const from = store.get(fromId)
    if (!from || !Array.isArray(epIds) || !epIds.length) return store.list()
    const idSet = new Set(epIds)
    const moved = (from.episodes || []).filter((e) => idSet.has(e.id))
    const kept = (from.episodes || []).filter((e) => !idSet.has(e.id))
    if (!moved.length) return store.list()
    const id = 'anime-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
    const title = (newTitle && newTitle.trim()) || from.title
    const episodes = moved.map((ep) => ({ ...ep, id: `${id}-ep${ep.number}`, animeId: id }))
    store.upsert({
      id,
      titleKey: titleKey(title),
      title,
      englishTitle: '',
      romaji: '',
      description: '',
      genres: from.genres || [],
      tags: [],
      rating: 0,
      status: 'plan',
      year: from.year,
      airDate: '',
      studio: '',
      voiceActors: [],
      coverUrl: '',
      coverGradient: from.coverGradient || '#1a1a2e',
      seasons: from.seasons || [1],
      aired: episodes.length,
      episodes,
      path: from.path,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    if (kept.length) {
      store.updateAnime(from.id, { episodes: kept, aired: kept.length })
    } else {
      store.remove(fromId)
    }
    return store.list()
  })
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
  ipcMain.handle('data:rebuild', async (e) => {
    const settings = store.getSettings()
    return rebuildDatabase(store, settings.libraryFolders || [], settings, scanProgressSender(e.sender))
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