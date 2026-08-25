// IPC 处理器：注册所有渲染进程可调用的通道
import { ipcMain, dialog, app, shell, BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import * as store from './store'
import { scanLibrary, rebuildDatabase, makeEpisodeId } from './scanner'
import { titleKey } from './parser'
import { saveLocalCover, cacheCover } from './coverCache'
import { fetchAiringSchedule, fetchOnline } from './metadata'
import { getWebInfo, startWebServer, stopWebServer, resetToken } from './webServer'

const SUBTITLE_EXTS = ['.srt', '.ass', '.ssa', '.vtt', '.sub']

// B-2 修复：字幕解码——国内 .srt/.ass 字幕大量使用 GBK/GB18030 编码，
// 原实现硬编码 utf-8 导致中文乱码。解码策略（零依赖，利用 Electron
// 内置 full-icu TextDecoder）：
// 1) BOM 判定：UTF-16 LE/BE、UTF-8 BOM 直接按对应编码解码；
// 2) 无 BOM：先尝试严格 UTF-8（fatal），成功即用（兼容纯 ASCII 与合法 UTF-8）；
// 3) 严格 UTF-8 失败：回退 GB18030（GBK 超集，任意字节序列均可解码，不会抛错）。
function decodeSubtitle(buf) {
  if (!buf || !buf.length) return ''
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
    if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch (e) {
    // 非纯 UTF-8：按简体中文环境最常见的 GB18030 解码
    return new TextDecoder('gb18030').decode(buf)
  }
}

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
  const send = (info) => {
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
  // P5：扫描结束时调用——取消节流定时器、丢弃未发送的残留进度并立即推送
  // done 事件，渲染端据此清空进度状态（避免残留旧值闪烁，也避免迟到的
  // 节流事件在 done 之后到达覆盖清空结果）
  send.end = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
    if (win && !win.isDestroyed()) win.webContents.send('scan:progress', { phase: 'done' })
  }
  return send
}

export function registerIpc() {
  // —— 番剧库 ——
  ipcMain.handle('library:get', () => store.list())
  ipcMain.handle('library:get-one', (_e, id) => store.get(id))

  // UX-03：手动扫描的取消控制器（每次扫描独占；scan:cancel 触发 abort）
  let scanAbort = null
  ipcMain.handle('library:scan', async (e) => {
    const settings = store.getSettings()
    const progress = scanProgressSender(e.sender)
    scanAbort = new AbortController()
    try {
      return await scanLibrary(store, settings.libraryFolders || [], settings, progress, scanAbort.signal)
    } finally {
      // P5：无论成功/失败/取消都通知渲染端扫描已结束，清空进度状态
      scanAbort = null
      progress.end()
    }
  })
  // UX-03：取消当前手动扫描（后台自动扫描不受影响）
  ipcMain.on('scan:cancel', () => {
    if (scanAbort) scanAbort.abort()
  })

  // N-06：标题更新时同步重算 titleKey——保持与扫描器分组键一致，
  // 否则用户改名后下次扫描会按旧 titleKey 匹配失败而新建重复条目
  ipcMain.handle('anime:update', (_e, id, patch) => {
    if (patch && typeof patch.title === 'string' && patch.title.trim()) {
      patch = { ...patch, titleKey: titleKey(patch.title) }
    }
    return store.updateAnime(id, patch)
  })
  ipcMain.handle('anime:remove', (_e, id) => store.remove(id))

  // —— 批量操作（N4）——
  // PF-02：返回增量 { upserts, removedIds }（原先返回全量 store.list()，
  // 每次批量操作都经 IPC 传输整个媒体库，大库时为 10MB 级结构化克隆开销）
  ipcMain.handle('anime:batch', (_e, { action, ids, payload }) => {
    const targets = (ids || []).map((id) => store.get(id)).filter(Boolean)
    if (!targets.length) return { upserts: [], removedIds: [] }
    const upserts = []
    const removedIds = []
    switch (action) {
      case 'remove':
        for (const a of targets) {
          store.remove(a.id)
          removedIds.push(a.id)
        }
        break
      case 'set-status': {
        const status = payload && payload.status
        if (status) {
          for (const a of targets) {
            const next = store.updateAnime(a.id, { status })
            if (next) upserts.push(next)
          }
        }
        break
      }
      case 'set-favorite': {
        const fav = Boolean(payload && payload.favorite)
        for (const a of targets) {
          const next = store.updateAnime(a.id, { isFavorite: fav })
          if (next) upserts.push(next)
        }
        break
      }
      case 'mark-watched':
      case 'mark-unwatched': {
        // B5：批量标记改为单次落盘 + 单次状态重算，避免 N 集触发 N 次全量写盘
        const watched = action === 'mark-watched'
        for (const a of targets) {
          const epIds = (a.episodes || []).map((e) => e.id)
          const next = store.setEpisodesWatchedBulk(a.id, epIds, watched)
          if (next) upserts.push(next)
        }
        break
      }
      case 'set-tags': {
        const tags = (payload && payload.tags) || []
        for (const a of targets) {
          const next = store.updateAnime(a.id, { tags })
          if (next) upserts.push(next)
        }
        break
      }
      default:
        return { upserts: [], removedIds: [] }
    }
    return { upserts, removedIds }
  })
  // —— 合并 / 拆分番剧（N3）——
  // PF-02：返回增量 { upserts, removedIds }，渲染层本地合并
  // 合并：把 from 的剧集追加到 to（集数冲突自动顺延），随后删除 from
  // B6：nextNum 单调递增分配冲突号，避免非连续编号下 while 循环导致编号漂移；
  // aired 取最终合并后的集数组长度（而非前值之和）。
  ipcMain.handle('anime:merge', (_e, fromId, toId) => {
    const from = store.get(fromId)
    const to = store.get(toId)
    if (!from || !to || fromId === toId) return { upserts: [], removedIds: [] }
    const base = to.episodes || []
    const used = new Set(base.map((e) => e.number))
    // B-09c：Math.max(...spread) 大数组 RangeError 风险，改 reduce
    let nextNum = base.reduce((m, e) => Math.max(m, e.number || 0), 0)
    const usedIds = new Set(base.map((e) => e.id))
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
        return {
          ...ep,
          id: makeEpisodeId(to.id, number, ep.filePath || ep.id, usedIds),
          animeId: to.id,
          number
        }
      })
    const episodes = [...base, ...moved]
    const merged = store.updateAnime(to.id, { episodes, aired: episodes.length })
    store.remove(fromId)
    return { upserts: merged ? [merged] : [], removedIds: [fromId] }
  })
  // 拆分：把指定剧集从 from 移出，创建为新番剧
  ipcMain.handle('anime:split', (_e, fromId, epIds, newTitle) => {
    const from = store.get(fromId)
    if (!from || !Array.isArray(epIds) || !epIds.length) return { upserts: [], removedIds: [] }
    const idSet = new Set(epIds)
    const moved = (from.episodes || []).filter((e) => idSet.has(e.id))
    const kept = (from.episodes || []).filter((e) => !idSet.has(e.id))
    if (!moved.length) return { upserts: [], removedIds: [] }
    const id = 'anime-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
    const title = (newTitle && newTitle.trim()) || from.title
    // B-01：拆分时同样保证组内 ID 唯一（number=0 未分类条目按路径哈希区分）
    const usedIds = new Set()
    const episodes = moved.map((ep) => ({
      ...ep,
      id: makeEpisodeId(id, ep.number, ep.filePath || ep.id, usedIds),
      animeId: id
    }))
    const newAnime = store.upsert({
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
    // B-3 修复：拆出的剧集保留 watched/progress，状态不应恒为 plan——
    // 按拆出剧集的真实观看情况收敛（全部已看→completed / 部分→watching / 其余→plan），
    // 与扫描合并 / updateAnime 的收口逻辑保持一致。
    store.recalcStatus(newAnime)
    store.save()
    if (kept.length) {
      const updated = store.updateAnime(from.id, { episodes: kept, aired: kept.length })
      return { upserts: [newAnime, ...(updated ? [updated] : [])], removedIds: [] }
    }
    store.remove(fromId)
    return { upserts: [newAnime], removedIds: [fromId] }
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
    fs.writeFileSync(res.filePath, JSON.stringify({ animes: store.list(), settings: store.getSettings(), watchHistory: store.getWatchHistory().slice().reverse() }, null, 2), 'utf-8')
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
    const progress = scanProgressSender(e.sender)
    try {
      return await rebuildDatabase(store, settings.libraryFolders || [], settings, progress)
    } finally {
      progress.end()
    }
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

  // —— O-04：观看历史 ——
  ipcMain.handle('history:get', () => store.getWatchHistory())

  // —— N-01：追番日历 ——
  // 取库内「正在观看」番剧的下一集放送时间（AniList，10min 缓存）。
  // 全部查询失败（网络不可达）时 ok=false，渲染端提示降级。
  ipcMain.handle('calendar:fetch', async () => {
    const watching = store.list().filter((a) => a.status === 'watching').slice(0, 50)
    if (!watching.length) return { ok: true, items: [] }
    const items = []
    let failed = 0
    let idx = 0
    const workers = Array.from({ length: Math.min(3, watching.length) }, async () => {
      while (idx < watching.length) {
        const a = watching[idx++]
        const s = await fetchAiringSchedule(a.title)
        if (s) {
          items.push({
            animeId: a.id,
            title: a.title,
            localCover: a.coverUrl || '',
            nextEpisode: s.nextEpisode,
            airingAt: s.airingAt,
            finished: s.status === 'FINISHED'
          })
        } else {
          failed++
        }
      }
    })
    await Promise.all(workers)
    // airingAt 升序（无放送信息的排末尾）
    items.sort((x, y) => (x.airingAt || Infinity) - (y.airingAt || Infinity))
    return { ok: failed < watching.length, items }
  })

  // —— N-05：更新检查 ——
  // 轻量方案：比对 GitHub Releases latest 与当前版本，无需 electron-updater。
  // 发布地址未配置时返回 unconfigured（开源项目发布前占位）。
  const GITHUB_REPO = '' // TODO: 发布时填入 'owner/anime-repo'
  // B-7：发布源未配置时渲染层隐藏「检查更新」入口，避免无意义占位按钮
  ipcMain.handle('app:has-update-source', () => Boolean(GITHUB_REPO))
  ipcMain.handle('app:check-update', async () => {
    if (!GITHUB_REPO) return { ok: false, reason: 'unconfigured' }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AnimeRepo' },
        signal: controller.signal
      })
      clearTimeout(timer)
      if (!res.ok) return { ok: false, reason: 'network' }
      const json = await res.json()
      const latest = String(json.tag_name || '').replace(/^v/, '')
      const current = app.getVersion()
      const hasUpdate = Boolean(latest) && latest !== current
      return { ok: true, hasUpdate, latest, current, url: json.html_url || '' }
    } catch (e) {
      return { ok: false, reason: 'network' }
    }
  })

  // —— N-02：外部播放器 ——
  // 用系统安装的 mpv / VLC 等播放器打开视频（内置 <video> 不支持 HEVC/Hi10P 等编码，
  // 外部播放器是当前唯一可靠的兜底方案）。校验：播放器已配置且存在、视频文件存在且
  // 位于媒体库文件夹内（与 anime:// 协议同一安全边界）。
  ipcMain.handle('player:open-external', (_e, filePath) => {
    const settings = store.getSettings()
    const player = settings.externalPlayerPath
    if (!player || !fs.existsSync(player)) {
      return { ok: false, error: '未配置外部播放器或程序路径无效' }
    }
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, error: '视频文件不存在' }
    }
    const folders = settings.libraryFolders || []
    const resolved = path.resolve(filePath).toLowerCase()
    const inLibrary = folders.some((f) => {
      const base = path.resolve(f).toLowerCase()
      return resolved === base || resolved.startsWith(base + path.sep)
    })
    if (!inLibrary) {
      return { ok: false, error: '文件不在媒体库文件夹内' }
    }
    try {
      // detached + unref：播放器生命周期独立于本应用，退出 AnimeRepo 不影响播放
      const child = execFile(player, [filePath], { detached: true, windowsHide: true }, () => {})
      child.unref()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: '启动播放器失败：' + e.message }
    }
  })
  // 选择外部播放器程序（exe/bat 等）
  ipcMain.handle('dialog:pick-executable', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: '可执行程序', extensions: ['exe', 'bat', 'cmd'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePaths.length) return null
    return res.filePaths[0]
  })

  // —— N-06：封面与图片选择 ——
  ipcMain.handle('dialog:pick-image', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }]
    })
    if (res.canceled || !res.filePaths.length) return null
    return res.filePaths[0]
  })
  // 本地图片 → 复制进封面缓存目录 → 更新 coverUrl（anime://cover 协议加载，离线可用）
  ipcMain.handle('anime:set-cover', async (_e, id, filePath) => {
    const anime = store.get(id)
    if (!anime) return null
    if (!filePath || !fs.existsSync(filePath)) return null
    const url = await saveLocalCover(filePath)
    if (!url) return null
    return store.updateAnime(id, { coverUrl: url })
  })

  // —— O-2：在线元数据手动刷新 ——
  // 强制跳过缓存重查（Bangumi → AniList），仅覆盖可安全合并的展示字段
  // （译名/简介/类型/年份/播出时间/工作室/声优/封面），保留用户标题、标签、
  // 评分与观看进度——避免 titleKey 突变导致下次扫描分组错乱。
  // 刷新结果写回覆盖旧的磁盘元数据缓存。
  ipcMain.handle('anime:refresh-metadata', async (_e, id) => {
    const anime = store.get(id)
    if (!anime) return null
    const info = await fetchOnline(anime.title, { force: true })
    if (!info || !info.title) return null
    const patch = {
      englishTitle: info.englishTitle || '',
      romaji: info.romaji || '',
      description: info.description || '',
      genres: info.genres || [],
      year: info.year || 0,
      airDate: info.airDate || '',
      studio: info.studio || '',
      voiceActors: info.voiceActors || []
    }
    // 新封面下载到本地缓存（失败回退原网络 URL，与扫描路径一致）
    if (info.coverUrl) patch.coverUrl = await cacheCover(info.coverUrl)
    return store.updateAnime(id, patch)
  })

  // —— 字幕 ——
  ipcMain.handle('subtitle:read', (_e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return null
      if (!SUBTITLE_EXTS.includes(path.extname(filePath).toLowerCase())) return null
      // B-2：按字节读取后做编码探测（UTF-8/UTF-16/GBK），替代硬编码 utf-8
      return decodeSubtitle(fs.readFileSync(filePath))
    } catch (e) {
      return null
    }
  })

  // —— F-4：局域网播放 ——
  // getWebInfo 返回服务状态、实际端口、带令牌的访问地址列表
  ipcMain.handle('web:get-info', () => getWebInfo())
  // 启停服务（开启时自动生成/复用令牌）
  ipcMain.handle('web:set-enabled', async (_e, enabled) => {
    store.updateSettings({ webServerEnabled: Boolean(enabled) })
    if (enabled) await startWebServer()
    else stopWebServer()
    return getWebInfo()
  })
  // 更新端口 / 是否允许局域网访问（已启用时自动重启服务）
  ipcMain.handle('web:update-config', async (_e, patch) => {
    const clean = {}
    if (patch && typeof patch === 'object') {
      if (typeof patch.port === 'number') {
        clean.webServerPort = Math.max(1, Math.min(65535, Math.round(patch.port)))
      }
      if (typeof patch.bindAll === 'boolean') clean.webServerBindAll = patch.bindAll
    }
    if (Object.keys(clean).length) {
      store.updateSettings(clean)
      if (store.getSettings().webServerEnabled) await startWebServer()
    }
    return getWebInfo()
  })
  // 重置访问令牌（旧地址立即失效，需重启服务使新令牌生效）
  ipcMain.handle('web:reset-token', async () => {
    resetToken()
    if (store.getSettings().webServerEnabled) await startWebServer()
    return getWebInfo()
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