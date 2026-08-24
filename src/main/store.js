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
  unmatchedAction: '保留在未分类中',
  autoNextEpisode: true,
  skipOpEd: true,
  hardwareDecode: true,
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
let state = { animes: [], settings: { ...DEFAULT_SETTINGS } }

function defaultState() {
  return {
    animes: [],
    settings: { ...DEFAULT_SETTINGS }
  }
}

function ensureDataFile() {
  state = { ...defaultState() }
  const dir = app.getPath('userData')
  fs.mkdirSync(dir, { recursive: true })
  dataFile = join(dir, 'animerepo-data.json')
  if (fs.existsSync(dataFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf-8'))
      if (parsed && Array.isArray(parsed.animes)) {
        state.animes = parsed.animes
      }
      if (parsed && parsed.settings && typeof parsed.settings === 'object') {
        state.settings = { ...DEFAULT_SETTINGS, ...parsed.settings }
      }
    } catch (e) {
      // 数据损坏时回退到默认状态
      state = { ...defaultState() }
    }
  }
}

// P4-3：数据落盘改为「合并写」——连续多次变更合并为一次异步写入，
// 避免每次进度保存都全量同步写文件阻塞主进程
let writeDirty = false
let writeInFlight = false

function save() {
  writeDirty = true
  if (writeInFlight) return
  writeInFlight = true
  writeLoop()
}

function writeLoop() {
  writeDirty = false
  const payload = JSON.stringify({ animes: state.animes, settings: state.settings }, null, 2)
  fs.writeFile(dataFile, payload, 'utf-8', (err) => {
    if (err) console.error('保存数据失败', err)
    if (writeDirty) writeLoop()
    else writeInFlight = false
  })
}

// 退出前同步落盘，确保异步写未完成时数据不丢失
function flushSaveSync() {
  writeDirty = false
  try {
    fs.writeFileSync(dataFile, JSON.stringify({ animes: state.animes, settings: state.settings }, null, 2), 'utf-8')
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
  if (typeof duration === 'number' && duration > 0) {
    ep.duration = Math.round(duration)
    // B1 修复：播放至结尾（剩余不足 10 秒）自动标记为已看
    // B3 修复：中途更新进度不再覆盖用户显式标记的已看状态
    if (ep.duration - ep.progress <= 10) {
      ep.watched = true
      ep.progress = ep.duration
    }
  }
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
  ep.watched = watched
  if (watched) {
    ep.progress = ep.duration || 0
  } else if (ep.duration > 0 && ep.progress >= ep.duration) {
    // 从「已看」取消：清零进度，回到未看状态（供 recalcStatus 正确判定）
    ep.progress = 0
  }
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

function importJson(json) {
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json
    if (Array.isArray(parsed.animes)) state.animes = parsed.animes
    if (parsed.settings && typeof parsed.settings === 'object') {
      state.settings = { ...DEFAULT_SETTINGS, ...parsed.settings }
    }
    save()
    return true
  } catch (e) {
    return false
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
  getSettings,
  updateSettings,
  dataPath,
  reset,
  importJson,
  DEFAULT_SETTINGS
}