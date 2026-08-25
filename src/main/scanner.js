// 媒体扫描服务：递归扫描库文件夹，识别视频文件并解析出番剧/剧集
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app, shell } from 'electron'
import { parseFilename, parseWithRegex, titleKey } from './parser'
import { offlineDefaults, fetchOnline } from './metadata'
import { cacheCover } from './coverCache'

const VIDEO_EXT = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|rmvb|rm)$/i
const SUBTITLE_EXT = /\.(srt|ass|ssa|vtt|sub)$/i
const METADATA_CONCURRENCY = 3
// P5：在线元数据连续失败熔断阈值——网络不可达（如 AniList 被墙）时
// 每部新番都要等满 10s 超时，大库首扫会被拖长至几十分钟；
// 连续失败达到阈值后跳过本轮剩余请求（新番仍以离线默认资料入库，下次扫描自动重试）
const METADATA_FAIL_LIMIT = 5

// B8：正则转义，构建视频格式白名单时防止用户输入的正则元字符破坏匹配
function escapeRe(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// B8：由 settings.videoFormats 构造视频判定函数；未配置时回退内置 VIDEO_EXT
function makeVideoTest(formats) {
  const list = (Array.isArray(formats) ? formats : []).filter(Boolean)
  if (!list.length) return (name) => VIDEO_EXT.test(name)
  const re = new RegExp(`\\.(${list.map(escapeRe).join('|')})$`, 'i')
  return (name) => re.test(name)
}

// B8：扫描深度设置 → 最大子目录层级（null 表示不设限）
function depthFromSetting(scanDepth) {
  if (scanDepth === '仅当前目录') return 0
  if (scanDepth === '一层子目录') return 1
  if (scanDepth === '两层子目录') return 2
  return null // 深度扫描 / 默认
}

// 在视频同目录查找全部候选字幕文件（启用 scanSubtitle 时使用），按优先级排序返回路径数组
// 优先级：同名 > 同名前缀 > 含中文字幕标记 > 扩展名 srt > ass
// P5：readdirSync → 异步 readdir——大库扫描时同步枚举目录会阻塞主进程事件循环，
// 使 IPC（窗口操作等）与 anime:// 封面协议请求排队，加剧界面卡死
async function findSubtitles(videoFile, folder, dirCache) {
  if (!videoFile || !folder) return []
  try {
    let entries = dirCache ? dirCache.get(folder) : null
    if (!entries) {
      entries = (await fs.promises.readdir(folder)).filter((n) => SUBTITLE_EXT.test(n))
      if (dirCache) dirCache.set(folder, entries)
    }
    if (!entries.length) return []
    const base = path.basename(videoFile).replace(/\.[^.]+$/, '').toLowerCase()
    const rank = (name) => {
      const n = path.basename(name).replace(/\.[^.]+$/, '').toLowerCase()
      let score = 0
      if (n === base) score += 100
      else if (n.startsWith(base)) score += 60
      if (/zh|chs|sc|简/.test(n)) score += 30
      if (/\.[sS][rR][tT]$/.test(name)) score += 10
      else if (/\.[aA][sS][sS]$/.test(name)) score += 5
      return score
    }
    entries.sort((a, b) => rank(b) - rank(a))
    return entries.map((n) => path.join(folder, n))
  } catch (e) {
    return []
  }
}

// ===== O-01：增量扫描缓存 =====
// 目录级 mtime 缓存：目录的 mtime 在其直接子项增删/改名时变化，
// 因此「mtime 未变 ⇒ 该目录的直接文件列表未变」成立（文件内容变更不影响扫描结果）。
// 复扫时对未变化目录跳过 readdir（大库主要开销），仅保留每目录一次 stat。
// 缓存持久化到 userData/scan-cache.json，重启后启动扫描同样走增量路径。
// signature：视频格式 + 扫描深度任一变化时缓存整体失效（遍历形态改变）。
let dirStatCache = new Map()
let scanCacheSignature = ''
let scanCacheLoaded = false
let scanCacheSaveTimer = null

function scanCacheFile() {
  return path.join(app.getPath('userData'), 'scan-cache.json')
}

function computeScanSignature(settings) {
  return JSON.stringify([
    (settings && settings.videoFormats) || [],
    (settings && settings.scanDepth) || ''
  ])
}

// 惰性加载磁盘缓存（失败静默回退全量扫描）
function loadScanCache(settings) {
  const sig = computeScanSignature(settings)
  if (!scanCacheLoaded) {
    scanCacheLoaded = true
    try {
      const raw = JSON.parse(fs.readFileSync(scanCacheFile(), 'utf-8'))
      if (raw && raw.signature === sig && raw.dirs && typeof raw.dirs === 'object') {
        for (const [dir, ent] of Object.entries(raw.dirs)) {
          if (ent && typeof ent.m === 'number' && Array.isArray(ent.v) && Array.isArray(ent.s)) {
            dirStatCache.set(dir, { mtimeMs: ent.m, videos: ent.v, subdirs: ent.s })
          }
        }
      }
    } catch (e) {
      /* 无缓存文件或损坏：全量扫描 */
    }
  }
  // 设置签名变化（或磁盘缓存属旧签名）：整体失效
  if (sig !== scanCacheSignature) {
    dirStatCache = new Map()
    scanCacheSignature = sig
  }
}

// 防抖持久化：扫描结束后调用；序列化体积为 目录数×路径，远小于媒体库本体
function scheduleScanCacheSave() {
  if (scanCacheSaveTimer) return
  scanCacheSaveTimer = setTimeout(() => {
    scanCacheSaveTimer = null
    try {
      const dirs = {}
      for (const [dir, ent] of dirStatCache) {
        dirs[dir] = { m: ent.mtimeMs, v: ent.videos, s: ent.subdirs }
      }
      const payload = JSON.stringify({ signature: scanCacheSignature, dirs })
      fs.writeFile(scanCacheFile(), payload, 'utf-8', () => {})
    } catch (e) {
      /* 保存失败不影响扫描 */
    }
  }, 2000)
}

// 异步递归遍历（P4-1：readdirSync → readdir 异步，避免大库扫描阻塞主进程）
// options：{ maxDepth, isVideo } —— maxDepth 限制子目录层级（null 不设限），isVideo 自定义视频判定
// O-01：接入目录级增量缓存——目录 mtime 未变时复用缓存的视频/子目录列表，跳过 readdir
async function walkFiles(root, options, onFile) {
  const { maxDepth, isVideo } = options || {}
  const stack = [{ dir: root, depth: 0 }]
  // Bug 6：已访问目录去重——普通目录按 resolve 规范化路径（零 I/O），
  // 符号链接目录额外按 realpath 真实路径去重，防止 junction 指向祖先时无限遍历；
  // 避免对每个目录都 realpath（大库会拖慢扫描）
  const visited = new Set()
  while (stack.length) {
    const { dir, depth } = stack.pop()
    const key = path.resolve(dir)
    if (visited.has(key)) continue
    visited.add(key)
    // O-01：目录 mtime 校验——缓存命中则跳过 readdir（缓存中的子目录仍会递归校验）
    let stat
    try {
      stat = await fs.promises.stat(dir)
    } catch (e) {
      continue
    }
    const cached = dirStatCache.get(key)
    if (cached && cached.mtimeMs === stat.mtimeMs.getTime()) {
      for (const f of cached.videos) onFile(f)
      if (maxDepth == null || depth < maxDepth) {
        for (const sub of cached.subdirs) stack.push({ dir: sub, depth: depth + 1 })
      }
      continue
    }
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch (e) {
      continue
    }
    // O-01：重建该目录缓存（含符号链接环路防护——指向已访问目标的链接不入缓存）
    const videos = []
    const subdirs = []
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        // 符号链接目录：解析真实路径去重（Windows junction 在此判定为 symbolic link）
        if (ent.isSymbolicLink()) {
          const real = await fs.promises.realpath(full).catch(() => full)
          if (visited.has(real)) continue
          visited.add(real)
        }
        subdirs.push(full)
        if (maxDepth == null || depth < maxDepth) {
          stack.push({ dir: full, depth: depth + 1 })
        }
      } else if (ent.isFile() && isVideo(ent.name)) {
        videos.push(full)
        onFile(full)
      }
    }
    dirStatCache.set(key, { mtimeMs: stat.mtimeMs.getTime(), videos, subdirs })
  }
}

// N6：读取本地 .nfo 信息（Kodi/Emby 风格，正则解析，不引入 XML 依赖）
// B8：按 settings.infoFormats 决定是否启用；当前仅支持 .nfo 文本解析，
// 其他扩展名（json/xml）因格式异构暂不解析，未含 nfo 则禁用本地信息。
// P5：readdirSync/readFileSync → 异步——preferLocalInfo 默认开启，
// 每个新番剧都会触发一次本地 NFO 读取，同步 I/O 会阻塞主进程
async function readLocalInfo(folder, infoFormats) {
  if (!folder) return null
  const exts = (Array.isArray(infoFormats) && infoFormats.length
    ? infoFormats
    : ['nfo'])
    .map((e) => String(e).replace(/^\./, '').toLowerCase())
  if (!exts.includes('nfo')) return null
  try {
    let nfo = ''
    for (const name of await fs.promises.readdir(folder)) {
      if (/\.nfo$/i.test(name)) { nfo = path.join(folder, name); break }
    }
    if (!nfo) return null
    const text = await fs.promises.readFile(nfo, 'utf-8')
    const get = (tag) => {
      const m = text.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([^<]*?)(?:\\]\\]>)?</${tag}>`, 'i'))
      return m ? m[1].trim() : ''
    }
    const genres = [...text.matchAll(/<genre>(?:<!\[CDATA\[)?([^<]*?)(?:\]\]>)?<\/genre>/gi)]
      .map((m) => m[1].trim())
      .filter(Boolean)
    const info = {
      title: get('title') || get('originaltitle') || get('tvdbTitle'),
      description: get('plot') || get('overview'),
      year: parseInt(get('year'), 10) || 0,
      airDate: get('premiered') || get('aired'),
      studio: get('studio'),
      genres
    }
    if (!info.title && !info.description && !info.year && !genres.length) return null
    return info
  } catch (e) {
    return null
  }
}

// B-01 修复：生成组内唯一剧集 ID——常规集数沿用 `${animeId}-ep${number}`（兼容历史数据，
// 保留观看进度匹配）；number=0（未识别文件兜底）或同组编号冲突时，追加文件路径哈希后缀
// 保证唯一。此前未分类文件全部兜底 number=0，同目录多个文件生成相同 ID，导致
// setProgress/setWatched 永远只命中第一条、观看进度互相覆盖、React key 冲突。
function makeEpisodeId(animeId, number, filePath, usedIds) {
  let id = `${animeId}-ep${number}`
  if (number === 0 || usedIds.has(id)) {
    const h = crypto.createHash('md5').update(filePath).digest('hex').slice(0, 8)
    id = `${animeId}-ep${number}-${h}`
    // 极端情况（同一路径产生多条记录）下追加序号兜底
    let i = 1
    while (usedIds.has(id)) id = `${animeId}-ep${number}-${h}-${i++}`
  }
  usedIds.add(id)
  return id
}

// O-01：剧集数组等价判定——文件、字幕、观看进度等关键维度均未变化时，
// 本次扫描无需写库（跳过 updateAnime）。既消除每轮扫描 N 次全量落盘，
// 也修正了自动同步「零变化也推送『N 部番剧更新』通知」的误报。
function episodesEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.number !== y.number ||
      x.filePath !== y.filePath ||
      x.title !== y.title ||
      x.season !== y.season ||
      x.watched !== y.watched ||
      x.progress !== y.progress ||
      x.duration !== y.duration ||
      x.airDate !== y.airDate ||
      x.subtitlePath !== y.subtitlePath
    ) return false
    const xs = Array.isArray(x.subtitlePaths) ? x.subtitlePaths : []
    const ys = Array.isArray(y.subtitlePaths) ? y.subtitlePaths : []
    if (xs.length !== ys.length || xs.some((p, j) => p !== ys[j])) return false
  }
  return true
}

// 并发限流执行器（P4-2：元数据请求并发，避免串行等待）
async function runPool(items, concurrency, fn) {
  if (!items.length) return
  let idx = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++
      await fn(items[i], i)
    }
  })
  await Promise.all(workers)
}

// P5：扫描互斥锁——手动扫描（library:scan）、引导扫描与后台自动扫描（autosync）
// 共用此入口。原先两者可并发双跑，I/O、元数据请求与全量写盘全部翻倍，
// 期间渲染进程还持续接收双份进度推送，是扫描白屏卡死的帮凶。
let scanRunning = false

// 主扫描：返回扫描摘要 + 变更增量（PF-02：不再回传全量库）
// onProgress：可选进度回调，阶段 collect（已发现文件数）/ metadata（在线元数据下载进度）
// signal：可选 AbortSignal（UX-03 扫描可取消）——各阶段边界检查，
// 取消时已写入的变更保留（均为合法合并），未处理部分跳过并标记 aborted
async function scanLibrary(store, folders, settings, onProgress, signal) {
  if (scanRunning) {
    // 已有扫描在进行：返回跳过标记，调用方不覆盖本地库状态
    return { scanned: 0, added: 0, updated: 0, removed: 0, skipped: true, changedAnimes: [], removedIds: [] }
  }
  scanRunning = true
  try {
    return await doScan(store, folders, settings, onProgress, signal)
  } finally {
    scanRunning = false
  }
}

async function doScan(store, folders, settings, onProgress, signal) {
  const result = { scanned: 0, added: 0, updated: 0 }
  // PF-02：变更增量收集——仅回传发生变化的番剧与被移除的条目 ID，
  // 渲染层本地合并，避免每次操作经 IPC 传输全量库（大库 ≈ 10MB 级结构化克隆）
  const changedAnimes = []
  const removedIds = []
  const aborted = () => Boolean(signal && signal.aborted)

  // B8：按设置构造视频格式判定与扫描深度
  const isVideo = makeVideoTest(settings && settings.videoFormats)
  const maxDepth = depthFromSetting(settings && settings.scanDepth)
  const recognizeMode = (settings && settings.recognizeMode) || '自动识别'
  const regexPattern = settings && settings.regexPattern

  // O-01：加载/校验增量扫描缓存（签名变化时自动失效）
  loadScanCache(settings)

  // 收集全部文件（P4-1：异步遍历；O-01：增量缓存命中目录跳过 readdir）
  const files = []
  for (const folder of folders || []) {
    if (aborted()) return { ...result, removed: 0, changedAnimes, removedIds, aborted: true }
    try {
      await walkFiles(folder, { maxDepth, isVideo }, (f) => {
        files.push(f)
        onProgress?.({ phase: 'collect', found: files.length })
      })
    } catch (e) {
      continue
    }
  }

  // 按 titleKey + season 分组
  const groups = new Map()
  // 字幕扫描：同目录 readdir 结果缓存，避免对同一目录重复枚举
  const dirCache = new Map()
  // B2 修复：无法识别的视频按 unmatchedAction 处理（默认「保留在未分类中」）
  const unmatchedAction = (settings && settings.unmatchedAction) || '保留在未分类中'
  // 被忽略/回收站处理的文件，供末尾清理段移除其历史残留条目
  const ignoredFiles = new Set()
  for (const file of files) {
    const folderName = path.basename(path.dirname(file))
    // B8：识别模式为「正则表达式」时优先按自定义正则解析，失败再回退默认启发式
    const parsed = recognizeMode === '正则表达式' && regexPattern
      ? (parseWithRegex(path.basename(file), regexPattern) || parseFilename(path.basename(file), folderName))
      : parseFilename(path.basename(file), folderName)
    // 解析失败（无有效集数）的文件进入未匹配处理
    if (!parsed.number) {
      if (unmatchedAction === '自动忽略') {
        ignoredFiles.add(file)
        continue
      }
      if (unmatchedAction === '移至回收站') {
        // 异步移入系统回收站，失败静默忽略，不阻塞扫描
        ignoredFiles.add(file)
        shell.trashItem(file).catch(() => {})
        continue
      }
      // '保留在未分类中'：以文件名兜底并入「未知番剧」分组
    }
    const key = `${parsed.titleKey}|${parsed.season}`
    if (!groups.has(key)) {
      groups.set(key, {
        titleKey: parsed.titleKey,
        animeTitle: parsed.animeTitle,
        season: parsed.season,
        path: path.dirname(file),
        episodes: []
      })
    }
    groups.get(key).episodes.push({
      file,
      number: parsed.number,
      epTitle: parsed.epTitle
    })
  }

  // P4-2/O5：并发预取「新番剧」在线元数据（并发限流 + fetchOnline 内存缓存，避免逐个串行等待）
  // P5：连续失败熔断——网络不可达时跳过本轮剩余请求，避免大库首扫被 10s×N 超时拖死
  const onlineCache = new Map()
  if (settings && settings.autoDownload) {
    const pending = [...groups.values()].filter((g) => !store.findByTitleKey(g.titleKey))
    if (pending.length) {
      let done = 0
      let consecutiveFails = 0
      onProgress?.({ phase: 'metadata', total: pending.length, current: 0 })
      await runPool(pending, METADATA_CONCURRENCY, async (g) => {
        if (aborted()) {
          done++
          return
        }
        if (consecutiveFails >= METADATA_FAIL_LIMIT) {
          done++
          onProgress?.({ phase: 'metadata', total: pending.length, current: done })
          return
        }
        const online = await fetchOnline(g.animeTitle)
        if (online && online.title) {
          onlineCache.set(g.titleKey, online)
          consecutiveFails = 0
        } else {
          consecutiveFails++
        }
        done++
        onProgress?.({ phase: 'metadata', total: pending.length, current: done })
      })
    }
  }

  // 合并写入
  for (const g of groups.values()) {
    // UX-03：合并阶段边界响应取消——已写入的组保留，剩余组跳过
    if (aborted()) break
    g.episodes.sort((a, b) => a.number - b.number)
    let anime = store.findByTitleKey(g.titleKey)
    if (anime && Array.isArray(anime.episodes)) {
      // 更新已有番剧：合并剧集（保留原有 watched/progress）
      const existingMap = new Map(anime.episodes.map((e) => [e.number, e]))
      // B-01：number=0 的未分类剧集无法按集数区分，改按文件路径匹配旧条目
      const existingByPath = new Map(
        anime.episodes.filter((e) => e.number === 0 && e.filePath).map((e) => [e.filePath, e])
      )
      // B-01：记录已占用 ID，防止同组重复编号（同集多版本文件）生成重复 ID
      const usedIds = new Set()
      const episodes = []
      for (const ge of g.episodes) {
        const old =
          ge.number > 0 ? existingMap.get(ge.number) : existingByPath.get(ge.file)
        let id
        if (old && !usedIds.has(old.id)) {
          id = old.id
          usedIds.add(id)
        } else {
          id = makeEpisodeId(anime.id, ge.number, ge.file, usedIds)
        }
        // B-04 修复：字幕在「剧集文件实际所在目录」查找——原先传组路径（首文件目录，
        // 遍历顺序随机），番剧剧集分散多目录（Season1/、OVA/ 等）时字幕全部错查
        const subs = settings && settings.scanSubtitle
          ? await findSubtitles(ge.file, path.dirname(ge.file), dirCache)
          : []
        episodes.push({
          id,
          animeId: anime.id,
          number: ge.number,
          title: old ? old.title : ge.epTitle || `第 ${ge.number} 话`,
          filePath: ge.file,
          duration: old ? old.duration : 0,
          watched: old ? old.watched : false,
          progress: old ? old.progress : 0,
          airDate: old ? old.airDate : '',
          season: g.season,
          subtitlePath: subs[0] || (old ? old.subtitlePath : ''),
          subtitlePaths: subs.length ? subs : (old && Array.isArray(old.subtitlePaths) ? old.subtitlePaths : [])
        })
      }
      // O-01：无实质变化（文件/字幕/进度全一致）时跳过写库与变更上报，
      // 避免每轮扫描全量落盘 + 自动同步零变化误报「N 部番剧更新」
      if (
        !episodesEqual(episodes, anime.episodes) ||
        anime.path !== g.path
      ) {
        anime = store.updateAnime(anime.id, {
          episodes,
          aired: episodes.length,
          path: g.path,
          updatedAt: new Date().toISOString()
        })
        changedAnimes.push(anime)
        result.updated++
      }
      result.scanned += g.episodes.length
    } else {
      // 新建番剧
      const id = 'anime-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
      let info = offlineDefaults(g.animeTitle, g.season, g.episodes.length)
      // N6：本地 NFO 信息优先（preferLocalInfo 开启时）
      // B-04 修复：剧集分散多目录时，逐个候选目录探测 NFO（原先只查组路径即首文件目录）
      let localInfo = null
      if (settings && settings.preferLocalInfo) {
        const candidateDirs = [...new Set(g.episodes.map((e) => path.dirname(e.file)))]
        for (const dir of candidateDirs) {
          localInfo = await readLocalInfo(dir, settings.infoFormats)
          if (localInfo) break
        }
      }
      if (localInfo) info = { ...info, ...localInfo }
      // 在线元数据补充（preferLocalInfo 时本地字段优先，否则在线覆盖默认）
      const online = onlineCache.get(g.titleKey)
      if (online && online.title) {
        info = localInfo ? { ...online, ...info } : { ...info, ...online }
      }
      // N8：封面下载到本地缓存（失败时回退为原网络 URL）
      if (info.coverUrl) info.coverUrl = await cacheCover(info.coverUrl)
      const episodes = []
      // B-01：组内 ID 唯一化（number=0 未分类文件追加路径哈希后缀）
      const usedIds = new Set()
      for (const ge of g.episodes) {
        // B-04：字幕在剧集文件实际所在目录查找
        const subs = settings && settings.scanSubtitle
          ? await findSubtitles(ge.file, path.dirname(ge.file), dirCache)
          : []
        episodes.push({
          id: makeEpisodeId(id, ge.number, ge.file, usedIds),
          animeId: id,
          number: ge.number,
          title: ge.epTitle || `第 ${ge.number} 话`,
          filePath: ge.file,
          duration: 0,
          watched: false,
          progress: 0,
          airDate: '',
          season: g.season,
          subtitlePath: subs[0] || '',
          subtitlePaths: subs
        })
      }
      anime = store.upsert({
        id,
        titleKey: g.titleKey,
        title: info.title,
        englishTitle: info.englishTitle || '',
        romaji: info.romaji || '',
        description: info.description || '',
        genres: info.genres || [],
        tags: [],
        rating: 0,
        status: 'plan',
        year: info.year,
        airDate: info.airDate || '',
        studio: info.studio || '',
        voiceActors: info.voiceActors || [],
        coverUrl: info.coverUrl || '',
        coverGradient: info.coverGradient || '#1a1a2e',
        seasons: [g.season],
        aired: episodes.length,
        episodes,
        path: g.path,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
      changedAnimes.push(anime)
      result.added++
      result.scanned += g.episodes.length
    }
  }

  // B2 修复：清理失效条目（数据一致性）——磁盘上已删除的剧集/番剧同步从库中移除
  // 仅当存在有效媒体库文件夹时才执行，避免空库扫描误清空数据
  let removed = 0
  // 1.5：扫描时是否清理失效条目由 cleanupOnScan 控制（默认开启）；关闭后扫描仅新增/更新，不做清理
  if (!aborted() && folders && folders.length && settings && settings.cleanupOnScan !== false) {
    // B2：被忽略/回收站处理的未匹配文件不再视为有效，对应历史条目将被清理
    const existingFiles = new Set(files.filter((f) => !ignoredFiles.has(f)))
    // P0 修复：区分「文件夹已被移除」与「扫描范围收缩」——
    // 文件仍属于当前媒体库文件夹、但本次未扫到（如缩小扫描深度/移除某视频格式）时，
    // 需结合磁盘存在性校验，避免误删仍在磁盘上的条目及其观看进度/评分/标签
    const folderRoots = folders.map((f) => path.resolve(f).toLowerCase())
    const underCurrentFolders = (filePath) => {
      if (!filePath) return false
      const p = path.resolve(filePath).toLowerCase()
      return folderRoots.some((root) => p === root || p.startsWith(root + path.sep))
    }
    const snapshot = store.list().slice()
    for (const a of snapshot) {
      // UX-03：清理阶段响应取消
      if (aborted()) break
      // P5：原 filter + fs.existsSync 逐条同步校验磁盘存在性，大库时阻塞主进程；
      // 改为循环内异步 access（filter 回调不支持 await）
      const alive = []
      for (const e of a.episodes || []) {
        if (!e.filePath) continue
        if (existingFiles.has(e.filePath)) {
          alive.push(e)
          continue
        }
        // 属于当前媒体库但未在本次扫描范围内：磁盘上仍存在则保留，避免误删
        if (underCurrentFolders(e.filePath)) {
          try {
            await fs.promises.access(e.filePath)
            alive.push(e)
          } catch {
            // 磁盘上已不存在
          }
        }
        // 媒体库文件夹已被移除或文件已不在任何当前媒体库内：视为失效清理（不入 alive）
      }
      if (alive.length === 0) {
        store.remove(a.id)
        removed++
        removedIds.push(a.id)
      } else if (alive.length !== (a.episodes || []).length) {
        const updated = store.updateAnime(a.id, { episodes: alive, aired: alive.length })
        if (updated) changedAnimes.push(updated)
      }
    }
  }

  // O-01：扫描结束后防抖持久化增量缓存（供下次启动扫描复用）
  scheduleScanCacheSave()

  // PF-02：返回增量（changedAnimes / removedIds），不再回传全量库
  return { ...result, removed, changedAnimes, removedIds, aborted: aborted() || undefined }
}

// 重建数据库：采用全量重扫实现「无损重建」，失败自动回滚
// B1 修复：原先「清空再重扫」会丢失所有观看进度/评分/收藏/标签。
// scanLibrary 的合并分支会保留已有剧集的 watched/progress，末尾清理逻辑
// 会移除磁盘上已不存在的失效条目，因此直接重扫即等价于无损重建。
async function rebuildDatabase(store, folders, settings, onProgress) {
  const backup = JSON.parse(JSON.stringify(store.list()))
  try {
    // 重建数据库需全量一致性，强制开启清理（不受 cleanupOnScan 关闭影响）
    return await scanLibrary(store, folders, { ...(settings || {}), cleanupOnScan: true }, onProgress)
  } catch (e) {
    // 扫描中途失败时回滚，避免部分写入导致数据损坏
    for (const a of backup) store.upsert(a)
    throw e
  }
}

export { scanLibrary, rebuildDatabase, VIDEO_EXT, makeEpisodeId }