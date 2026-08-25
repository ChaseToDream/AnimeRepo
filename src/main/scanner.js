// 媒体扫描服务：递归扫描库文件夹，识别视频文件并解析出番剧/剧集
import fs from 'fs'
import path from 'path'
import { shell } from 'electron'
import { parseFilename, parseWithRegex, titleKey } from './parser'
import { offlineDefaults, fetchOnline } from './metadata'
import { cacheCover } from './coverCache'

const VIDEO_EXT = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|rmvb|rm)$/i
const SUBTITLE_EXT = /\.(srt|ass|ssa|vtt|sub)$/i
const METADATA_CONCURRENCY = 3

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
function findSubtitles(videoFile, folder, dirCache) {
  if (!videoFile || !folder) return []
  try {
    let entries = dirCache ? dirCache.get(folder) : null
    if (!entries) {
      entries = fs.readdirSync(folder).filter((n) => SUBTITLE_EXT.test(n))
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

// 异步递归遍历（P4-1：readdirSync → readdir 异步，避免大库扫描阻塞主进程）
// options：{ maxDepth, isVideo } —— maxDepth 限制子目录层级（null 不设限），isVideo 自定义视频判定
async function walkFiles(root, options, onFile) {
  const { maxDepth, isVideo } = options || {}
  const stack = [{ dir: root, depth: 0 }]
  // Bug 6：已访问目录去重（realpath 解析符号链接/junction），防止目录结构指向祖先时无限遍历
  const visited = new Set()
  while (stack.length) {
    const { dir, depth } = stack.pop()
    const key = await fs.promises.realpath(dir).catch(() => dir)
    if (visited.has(key)) continue
    visited.add(key)
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch (e) {
      continue
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (maxDepth == null || depth < maxDepth) {
          stack.push({ dir: full, depth: depth + 1 })
        }
      } else if (ent.isFile() && isVideo(ent.name)) {
        onFile(full)
      }
    }
  }
}

// N6：读取本地 .nfo 信息（Kodi/Emby 风格，正则解析，不引入 XML 依赖）
// B8：按 settings.infoFormats 决定是否启用；当前仅支持 .nfo 文本解析，
// 其他扩展名（json/xml）因格式异构暂不解析，未含 nfo 则禁用本地信息。
function readLocalInfo(folder, infoFormats) {
  if (!folder) return null
  const exts = (Array.isArray(infoFormats) && infoFormats.length
    ? infoFormats
    : ['nfo'])
    .map((e) => String(e).replace(/^\./, '').toLowerCase())
  if (!exts.includes('nfo')) return null
  try {
    let nfo = ''
    for (const name of fs.readdirSync(folder)) {
      if (/\.nfo$/i.test(name)) { nfo = path.join(folder, name); break }
    }
    if (!nfo) return null
    const text = fs.readFileSync(nfo, 'utf-8')
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

// 主扫描：返回新增/更新后的番剧列表
// onProgress：可选进度回调，阶段 collect（已发现文件数）/ metadata（在线元数据下载进度）
async function scanLibrary(store, folders, settings, onProgress) {
  const result = { scanned: 0, added: 0, updated: 0 }

  // B8：按设置构造视频格式判定与扫描深度
  const isVideo = makeVideoTest(settings && settings.videoFormats)
  const maxDepth = depthFromSetting(settings && settings.scanDepth)
  const recognizeMode = (settings && settings.recognizeMode) || '自动识别'
  const regexPattern = settings && settings.regexPattern

  // 收集全部文件（P4-1：异步遍历，避免阻塞主进程）
  const files = []
  for (const folder of folders || []) {
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
  const onlineCache = new Map()
  if (settings && settings.autoDownload) {
    const pending = [...groups.values()].filter((g) => !store.findByTitleKey(g.titleKey))
    if (pending.length) {
      let done = 0
      onProgress?.({ phase: 'metadata', total: pending.length, current: 0 })
      await runPool(pending, METADATA_CONCURRENCY, async (g) => {
        const online = await fetchOnline(g.animeTitle)
        if (online && online.title) onlineCache.set(g.titleKey, online)
        done++
        onProgress?.({ phase: 'metadata', total: pending.length, current: done })
      })
    }
  }

  // 合并写入
  for (const g of groups.values()) {
    g.episodes.sort((a, b) => a.number - b.number)
    let anime = store.findByTitleKey(g.titleKey)
    if (anime && Array.isArray(anime.episodes)) {
      // 更新已有番剧：合并剧集（保留原有 watched/progress）
      const existingMap = new Map(anime.episodes.map((e) => [e.number, e]))
      const episodes = g.episodes.map((ge) => {
        const old = existingMap.get(ge.number)
        const subs = settings && settings.scanSubtitle ? findSubtitles(ge.file, g.path, dirCache) : []
        return {
          id: old ? old.id : `${anime.id}-ep${ge.number}`,
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
        }
      })
      anime = store.updateAnime(anime.id, {
        episodes,
        aired: episodes.length,
        path: g.path,
        updatedAt: new Date().toISOString()
      })
      result.updated++
    } else {
      // 新建番剧
      const id = 'anime-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
      let info = offlineDefaults(g.animeTitle, g.season, g.episodes.length)
      // N6：本地 NFO 信息优先（preferLocalInfo 开启时）
      let localInfo = null
      if (settings && settings.preferLocalInfo) localInfo = readLocalInfo(g.path, settings.infoFormats)
      if (localInfo) info = { ...info, ...localInfo }
      // 在线元数据补充（preferLocalInfo 时本地字段优先，否则在线覆盖默认）
      const online = onlineCache.get(g.titleKey)
      if (online && online.title) {
        info = localInfo ? { ...online, ...info } : { ...info, ...online }
      }
      // N8：封面下载到本地缓存（失败时回退为原网络 URL）
      if (info.coverUrl) info.coverUrl = await cacheCover(info.coverUrl)
      const episodes = g.episodes.map((ge, i) => {
        const subs = settings && settings.scanSubtitle ? findSubtitles(ge.file, g.path, dirCache) : []
        return {
          id: `${id}-ep${ge.number}`,
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
        }
      })
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
      result.added++
    }
    result.scanned += g.episodes.length
  }

  // B2 修复：清理失效条目（数据一致性）——磁盘上已删除的剧集/番剧同步从库中移除
  // 仅当存在有效媒体库文件夹时才执行，避免空库扫描误清空数据
  let removed = 0
  // 1.5：扫描时是否清理失效条目由 cleanupOnScan 控制（默认开启）；关闭后扫描仅新增/更新，不做清理
  if (folders && folders.length && settings && settings.cleanupOnScan !== false) {
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
      const alive = (a.episodes || []).filter((e) => {
        if (!e.filePath) return false
        if (existingFiles.has(e.filePath)) return true
        // 属于当前媒体库但未在本次扫描范围内：磁盘上仍存在则保留，避免误删
        if (underCurrentFolders(e.filePath)) {
          try {
            return fs.existsSync(e.filePath)
          } catch {
            return false
          }
        }
        // 媒体库文件夹已被移除或文件已不在任何当前媒体库内：视为失效清理
        return false
      })
      if (alive.length === 0) {
        store.remove(a.id)
        removed++
      } else if (alive.length !== a.episodes.length) {
        store.updateAnime(a.id, { episodes: alive, aired: alive.length })
      }
    }
  }

  return { ...result, removed, animes: store.list() }
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

export { scanLibrary, rebuildDatabase, VIDEO_EXT }