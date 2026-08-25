import { app } from 'electron'
import { join } from 'path'
import fs from 'fs'

const DEFAULT_SETTINGS = {
  libraryFolders: [],
  autoScanOnStartup: true,
  scanSubtitle: false,
  autoDownload: true,
  scanDepth: '深度扫描',
  videoFormats: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm'],
  infoFormats: ['nfo', 'json', 'xml'],
  recognizeMode: '自动识别',
  regexPattern: '\\[(.*?)\\]\\s*(.+?)\\s*-\\s*(\\d+)',
  preferLocalInfo: true,
  // 1.5：扫描时是否清理失效条目（磁盘上已删除的剧集/番剧）；关闭后扫描仅新增/更新
  cleanupOnScan: true,
  unmatchedAction: '保留在未分类中',
  autoNextEpisode: true,
  skipOpEd: true,
  hardwareDecode: true,
  // N-02：外部播放器程序路径（空 = 使用内置播放器）
  externalPlayerPath: '',
  defaultPlaySpeed: 1.0,
  subtitleFontSize: 'medium',
  subtitleFont: '思源黑体',
  subtitleStroke: true,
  subtitleBottomMargin: 60,
  preferredSubtitleLang: '简体中文',
  preferredAudioLang: '日语',
  defaultVolume: 80,
  audioGain: false,
  outputDevice: '系统默认',
  themeMode: '深色',
  accentColor: '#32F08C',
  posterDisplayMode: '竖版海报',
  uiDensity: '标准',
  enableAnimations: true,
  uiLanguage: '简体中文',
  dateFormat: 'YYYY-MM-DD',
  ratingSystem: '10分制'
}

let dataFile = ''
let state = { animes: [], settings: { ...DEFAULT_SETTINGS }, watchHistory: [] }

function defaultState() {
  return {
    animes: [],
    settings: { ...DEFAULT_SETTINGS },
    watchHistory: []
  }
}

function ensureDataFile() {
  state = { ...defaultState() }
  const dir = app.getPath('userData')
  fs.mkdirSync(dir, { recursive: true })
  dataFile = join(dir, 'animerepo-data.json')
  // B-02：清理上次异常退出可能残留的临时写盘文件（原子 rename 前中断的产物）
  try {
    const tmpFile = dataFile + '.tmp'
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  } catch (e) {
    /* 清理失败不影响启动 */
  }
  if (fs.existsSync(dataFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf-8'))
      if (parsed && Array.isArray(parsed.animes)) {
        state.animes = parsed.animes
      }
      if (parsed && parsed.settings && typeof parsed.settings === 'object') {
        state.settings = { ...DEFAULT_SETTINGS, ...parsed.settings }
      }
      // O-04：观看日志（历史数据文件无此字段时保持空数组）
      if (parsed && Array.isArray(parsed.watchHistory)) {
        state.watchHistory = parsed.watchHistory
      }
    } catch (e) {
      // 数据损坏时回退到默认状态
      state = { ...defaultState() }
    }
  }
}

// P4-3：数据落盘改为「防抖 + 合并写」——连续多次变更合并为一次异步写入，
// 避免每次进度保存都全量同步写文件阻塞主进程；退出前由 flushSaveSync 同步兜底
let writeDirty = false
let writeInFlight = false
let writeTimer = null
// B-02 修复：写盘序号——flushSaveSync 同步落盘时推进序号，
// 使飞行中的异步写入在完成时识别到自身已过期并丢弃结果，
// 防止退出时旧 payload 后完成覆盖同步写入的新数据（静默丢失进度/扫描结果）
let writeGeneration = 0
const WRITE_DEBOUNCE = 300

function save() {
  writeDirty = true
  // 已有防抖定时器或写盘在进行中：等待合并，由定时器/写盘完成后的兜底逻辑统一落盘
  if (writeInFlight || writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    writeInFlight = true
    writeLoop()
  }, WRITE_DEBOUNCE)
}

// B-02 修复：写临时文件 + 原子 rename 替换——避免进程中断/断电时
// 数据文件被写一半导致 JSON 损坏（ensureDataFile 只能整体回退默认，损失全部数据）
function persistPayload(payload) {
  const gen = ++writeGeneration
  const tmpFile = dataFile + '.tmp'
  fs.writeFile(tmpFile, payload, 'utf-8', (err) => {
    if (err) {
      console.error('保存数据失败', err)
      settleWrite()
      return
    }
    // 序号已落后：flushSaveSync 已同步写入更新的数据，丢弃本次（旧 payload）结果
    if (gen !== writeGeneration) {
      try { fs.unlinkSync(tmpFile) } catch (e) { /* 可能已被清理 */ }
      return
    }
    fs.rename(tmpFile, dataFile, (renameErr) => {
      if (renameErr) {
        console.error('保存数据失败', renameErr)
        try { fs.unlinkSync(tmpFile) } catch (e) { /* ignore */ }
      }
      settleWrite()
    })
  })
}

// 单轮写入收尾：期间又有新变更则继续合并写，否则复位飞行标记
function settleWrite() {
  if (writeDirty) writeLoop()
  else writeInFlight = false
}

function writeLoop() {
  writeDirty = false
  persistPayload(JSON.stringify({ animes: state.animes, settings: state.settings, watchHistory: state.watchHistory }, null, 2))
}

// 退出前同步落盘，确保异步写未完成时数据不丢失
function flushSaveSync() {
  writeDirty = false
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  // B-02：推进写盘序号作废飞行中的异步写入（其完成后将丢弃旧 payload，
  // 避免晚到回调覆盖本次同步写入的新数据），并复位飞行标记
  writeGeneration++
  writeInFlight = false
  try {
    fs.writeFileSync(dataFile, JSON.stringify({ animes: state.animes, settings: state.settings, watchHistory: state.watchHistory }, null, 2), 'utf-8')
  } catch (e) {
    console.error('保存数据失败', e)
  }
}

// —— 番剧 ——
function list() {
  return state.animes
}

function get(id) {
  return state.animes.find((a) => a.id === id) || null
}

function upsert(anime) {
  const idx = state.animes.findIndex((a) => a.id === anime.id)
  if (idx >= 0) {
    state.animes[idx] = { ...state.animes[idx], ...anime }
  } else {
    state.animes.push(anime)
  }
  save()
  return idx >= 0 ? state.animes[idx] : anime
}

function remove(id) {
  state.animes = state.animes.filter((a) => a.id !== id)
  save()
}

function updateAnime(id, patch) {
  const idx = state.animes.findIndex((a) => a.id === id)
  if (idx < 0) return null
  const next = { ...state.animes[idx], ...patch, updatedAt: new Date().toISOString() }
  // B7：当仅更新 episodes（如扫描合并剧集）且未显式指定状态时，
  // 按观看进度收敛 status；显式传 status（批量/编辑）不被覆盖。
  if (
    Object.prototype.hasOwnProperty.call(patch, 'episodes') &&
    !Object.prototype.hasOwnProperty.call(patch, 'status')
  ) {
    recalcStatus(next)
  }
  state.animes[idx] = next
  save()
  return next
}

function findByTitleKey(titleKey) {
  return state.animes.find((a) => a.titleKey === titleKey) || null
}

// —— 剧集进度 ——

// O-04：观看日志——仅在「看完一集」时追加记录（看完=标记已看的瞬间），
// 供统计页集数口径与观看历史页使用；环形上限 HISTORY_LIMIT 条
const HISTORY_LIMIT = 500

function recordWatch(anime, ep) {
  if (!anime || !ep) return
  state.watchHistory.push({
    id: 'wh-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    animeId: anime.id,
    animeTitle: anime.title,
    epId: ep.id,
    epNumber: ep.number,
    seconds: ep.duration || 0,
    watchedAt: new Date().toISOString()
  })
  if (state.watchHistory.length > HISTORY_LIMIT) {
    state.watchHistory = state.watchHistory.slice(-HISTORY_LIMIT)
  }
}

// 统一计算番剧观看状态（B4 修复：取消全部已看后正确降级）
// 规则：全部已看 → completed；部分已看或有播放进度 → watching；否则 → plan
function recalcStatus(anime) {
  const all = anime.episodes || []
  if (!all.length) return
  const watchedCount = all.filter((e) => e.watched).length
  const inProgress = all.some((e) => !e.watched && e.progress > 0)
  if (watchedCount === all.length) {
    anime.status = 'completed'
  } else if (watchedCount > 0 || inProgress) {
    anime.status = 'watching'
  } else {
    anime.status = 'plan'
  }
}

function setEpisodeProgress(animeId, epId, seconds, duration) {
  const anime = get(animeId)
  if (!anime) return null
  const ep = anime.episodes.find((e) => e.id === epId)
  if (!ep) return null
  ep.progress = Math.round(seconds)
  let justWatched = false
  if (typeof duration === 'number' && duration > 0) {
    ep.duration = Math.round(duration)
    // B1 修复：播放至结尾（剩余不足 10 秒）自动标记为已看
    // B3 修复：中途更新进度不再覆盖用户显式标记的已看状态
    if (ep.duration - ep.progress <= 10) {
      justWatched = !ep.watched
      ep.watched = true
      ep.progress = ep.duration
    }
  }
  if (justWatched) recordWatch(anime, ep)
  const lastModifiedAt = new Date().toISOString()
  anime.lastWatchedEpisode = epId
  anime.lastWatchedAt = lastModifiedAt
  anime.updatedAt = lastModifiedAt
  recalcStatus(anime)
  save()
  return anime
}

function setEpisodeWatched(animeId, epId, watched) {
  const anime = get(animeId)
  if (!anime) return null
  const ep = anime.episodes.find((e) => e.id === epId)
  if (!ep) return null
  const justWatched = watched && !ep.watched
  ep.watched = watched
  if (watched) {
    ep.progress = ep.duration || 0
  } else if (ep.duration > 0 && ep.progress >= ep.duration) {
    // 从「已看」取消：清零进度，回到未看状态（供 recalcStatus 正确判定）
    ep.progress = 0
  }
  if (justWatched) recordWatch(anime, ep)
  anime.updatedAt = new Date().toISOString()
  recalcStatus(anime)
  save()
  return anime
}

// B5：批量标记多个剧集的已看状态——只触发一次 recalcStatus 与一次落盘，
// 避免批量操作 N 集时 N 次全量写盘 + N 次状态重算
function setEpisodesWatchedBulk(animeId, epIds, watched) {
  const anime = get(animeId)
  if (!anime) return null
  const idSet = new Set(epIds || [])
  if (!idSet.size) return anime
  for (const ep of anime.episodes || []) {
    if (!idSet.has(ep.id)) continue
    if (watched && !ep.watched) recordWatch(anime, ep)
    ep.watched = watched
    if (watched) {
      ep.progress = ep.duration || 0
    } else if (ep.duration > 0 && ep.progress >= ep.duration) {
      ep.progress = 0
    }
  }
  anime.updatedAt = new Date().toISOString()
  recalcStatus(anime)
  save()
  return anime
}

// —— 观看历史（O-04）——
function getWatchHistory() {
  return state.watchHistory.slice().reverse() // 新的在前
}

// —— 设置 ——
function getSettings() {
  return { ...state.settings }
}

function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch }
  save()
  return { ...state.settings }
}

// —— 数据管理 ——
function dataPath() {
  return dataFile
}

function reset() {
  state = { ...defaultState() }
  save()
}

// B-06 修复：导入数据结构校验——畸形条目（null / 缺 id / 数组字段非数组等）
// 直接进入渲染层会导致页面崩溃（如 animes: [null] 或 episodes 被写成字符串）。
// 导入前逐条校验并规范化，非法条目剔除后统计上报，不再静默全量接受。
function normalizeImportedAnime(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null
  const arr = (v) => (Array.isArray(v) ? v : [])
  const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback)
  return {
    ...raw,
    title: str(raw.title, '未知番剧'),
    description: str(raw.description),
    coverUrl: str(raw.coverUrl),
    coverGradient: str(raw.coverGradient, '#1a1a2e'),
    genres: arr(raw.genres),
    tags: arr(raw.tags),
    voiceActors: arr(raw.voiceActors),
    seasons: arr(raw.seasons),
    // 剧集数组整体非法时置空；条目内非对象元素剔除
    episodes: arr(raw.episodes).filter(
      (e) => e && typeof e === 'object' && typeof e.id === 'string' && e.id
    )
  }
}

// 导入 JSON：返回 { ok, imported, skipped }；ok=false 表示文件解析失败/结构无效
function importJson(json) {
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.animes)) {
      return { ok: false, imported: 0, skipped: 0 }
    }
    const valid = []
    let skipped = 0
    for (const item of parsed.animes) {
      const anime = normalizeImportedAnime(item)
      if (anime) valid.push(anime)
      else skipped++
    }
    state.animes = valid
    if (parsed.settings && typeof parsed.settings === 'object') {
      state.settings = { ...DEFAULT_SETTINGS, ...parsed.settings }
    }
    // O-04：观看日志随导入恢复（结构非法时清空）
    state.watchHistory = Array.isArray(parsed.watchHistory)
      ? parsed.watchHistory.filter((h) => h && typeof h === 'object' && h.animeId)
      : []
    save()
    return { ok: true, imported: valid.length, skipped }
  } catch (e) {
    return { ok: false, imported: 0, skipped: 0 }
  }
}

export {
  ensureDataFile,
  save,
  flushSaveSync,
  list,
  get,
  upsert,
  remove,
  updateAnime,
  findByTitleKey,
  setEpisodeProgress,
  setEpisodeWatched,
  setEpisodesWatchedBulk,
  recalcStatus,
  getWatchHistory,
  getSettings,
  updateSettings,
  dataPath,
  reset,
  importJson,
  DEFAULT_SETTINGS
}