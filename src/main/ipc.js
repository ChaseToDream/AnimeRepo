// IPC 处理器：注册所有渲染进程可调用的通道
import { ipcMain, dialog, app, shell, BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import * as store from './store'
import { scanLibrary, rebuildDatabase, makeEpisodeId } from './scanner'
import { titleKey } from './parser'
import { saveLocalCover, cacheCover } from './coverCache'
import { fetchAiringSchedule, fetchOnline, offlineDefaults } from './metadata'
import { getWebInfo, startWebServer, stopWebServer, resetToken } from './webServer'
import { restartFileWatch } from './fileWatcher'
import { decodeTextBuffer } from './encoding'

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

  // —— F-7：手动添加“想看”占位条目（无剧集文件，供追更/占位） ——
  // V3-2：标题查重——同名条目已存在时不重复创建，返回 exists 供前端提示
  ipcMain.handle('anime:create', (_e, title) => {
    const t = String(title || '').trim()
    if (!t) return null
    const key = titleKey(t)
    if (store.findByTitleKey(key)) {
      return { ok: false, exists: true, title: t }
    }
    const id = 'anime-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
    const info = offlineDefaults(t, 1, 0)
    const now = new Date().toISOString()
    const anime = store.upsert({
      id,
      titleKey: key,
      title: t,
      englishTitle: '',
      romaji: '',
      description: '',
      genres: [],
      tags: [],
      rating: 0,
      status: 'plan',
      year: new Date().getFullYear(),
      airDate: '',
      studio: '',
      voiceActors: [],
      coverUrl: '',
      coverGradient: info.coverGradient,
      seasons: [1],
      aired: 0,
      episodes: [],
      path: '',
      createdAt: now,
      updatedAt: now
    })
    return { ok: true, anime }
  })

  // —— F-9：标签管理（合并/重命名/删除）——
  // 统一实现：把 targetTag 全量替换为 nextTag（空串=删除）；命中标签的条目
  // 批量写库（save 防抖合并，仅一次落盘）
  function applyTagRename(targetTag, nextTag) {
    const upserts = []
    for (const a of store.list()) {
      const tags = a.tags || []
      if (!tags.includes(targetTag)) continue
      let next
      if (nextTag) {
        next = [...tags.filter((t) => t !== targetTag && t !== nextTag), nextTag]
      } else {
        next = tags.filter((t) => t !== targetTag)
      }
      const updated = store.updateAnime(a.id, { tags: next })
      if (updated) upserts.push(updated)
    }
    return upserts
  }
  // 重命名 / 合并：oldTag → newTag
  ipcMain.handle('anime:replace-tag', (_e, oldTag, newTag) => {
    const from = String(oldTag || '').trim()
    const to = String(newTag || '').trim()
    if (!from || from === to) return { upserts: [] }
    return { upserts: applyTagRename(from, to) }
  })
  // 删除：从所有条目移除该标签
  ipcMain.handle('anime:remove-tag', (_e, tag) => {
    const t = String(tag || '').trim()
    if (!t) return { upserts: [] }
    return { upserts: applyTagRename(t, '') }
  })

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
  ipcMain.handle('settings:update', (_e, patch) => {
    const next = store.updateSettings(patch)
    // F-2：文件监控开关或媒体库文件夹列表变化时，按新设置重启监控
    if (patch && (Object.prototype.hasOwnProperty.call(patch, 'fileWatchEnabled') || Object.prototype.hasOwnProperty.call(patch, 'libraryFolders'))) {
      restartFileWatch()
    }
    return next
  })
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
  // UX-14：数据文件最后修改时间（备份意识提示）
  ipcMain.handle('data:last-saved', () => {
    try {
      const p = store.dataPath()
      if (p && fs.existsSync(p)) {
        const st = fs.statSync(p)
        return st.mtimeMs || 0
      }
    } catch (e) {
      /* ignore */
    }
    return 0
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
  // N-5：打开项目 LICENSE 文件（系统默认编辑器）
  ipcMain.handle('app:open-license', () => {
    try {
      const licensePath = path.join(app.getAppPath(), 'LICENSE')
      if (fs.existsSync(licensePath)) {
        shell.openPath(licensePath)
        return true
      }
      return false
    } catch (e) {
      return false
    }
  })
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
      // N-1：.bat/.cmd/.ps1 等脚本无法用 execFile 直接执行（Windows 抛 EINVAL），
      // V3-4：脚本经系统 shell（ComSpec）以参数数组方式启动，避免路径含引号被截断；
      //       .exe 保持直启，避免 shell 注入面。
      const ext = path.extname(player).toLowerCase()
      let child
      if (ext === '.bat' || ext === '.cmd' || ext === '.ps1') {
        const shell = process.env.ComSpec || 'cmd.exe'
        child = execFile(shell, ['/c', player, filePath], { detached: true, windowsHide: true }, () => {})
      } else {
        child = execFile(player, [filePath], { detached: true, windowsHide: true }, () => {})
      }
      // detached + unref：播放器生命周期独立于本应用，退出 AnimeRepo 不影响播放
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

  // —— O-10：批量补全在线元数据 ——
  // 无 ids 时自动选择「缺封面或简介」的条目；强制跳过缓存重查（Bangumi → AniList），
  // 并发限流 3；仅覆盖展示字段（同单条刷新），保留标题/标签/评分/进度。
  ipcMain.handle('anime:batch-refresh-metadata', async (_e, ids) => {
    const selected = new Set(Array.isArray(ids) ? ids : [])
    const targets = selected.size
      ? store.list().filter((a) => selected.has(a.id))
      : store.list().filter((a) => Boolean(a && (a.title || '').trim()) && (!a.coverUrl || !a.description))
    if (!targets.length) return { updated: 0, failed: 0, total: 0, upserts: [] }
    const upserts = []
    let failed = 0
    let idx = 0
    const CONC = 3
    await Promise.all(
      Array.from({ length: Math.min(CONC, targets.length) }, async () => {
        while (idx < targets.length) {
          const a = targets[idx++]
          try {
            const info = await fetchOnline(a.title, { force: true })
            if (!info || !info.title) {
              failed++
              continue
            }
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
            if (info.coverUrl) patch.coverUrl = await cacheCover(info.coverUrl)
            const next = store.updateAnime(a.id, patch)
            if (next) upserts.push(next)
          } catch (e) {
            failed++
          }
        }
      })
    )
    return { updated: upserts.length, failed, total: targets.length, upserts }
  })

  // —— 字幕 ——
  ipcMain.handle('subtitle:read', (_e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return null
      if (!SUBTITLE_EXTS.includes(path.extname(filePath).toLowerCase())) return null
      // B-2/V3-3：按字节读取后做编码探测（UTF-8/UTF-16/GBK），替代硬编码 utf-8
      return decodeTextBuffer(fs.readFileSync(filePath))
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