// 媒体扫描服务：递归扫描库文件夹，识别视频文件并解析出番剧/剧集
import fs from 'fs'
import path from 'path'
import { parseFilename, titleKey } from './parser'
import { offlineDefaults, fetchOnline } from './metadata'

const VIDEO_EXT = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|rmvb|rm)$/i
const SUBTITLE_EXT = /\.(srt|ass|ssa|vtt|sub)$/i

// 在视频同目录查找最匹配的字幕文件（启用 scanSubtitle 时使用）
// 优先级：同名 > 同名前缀 > 含中文字幕标记 > 扩展名 srt > ass
function findSubtitle(videoFile, folder, dirCache) {
  if (!videoFile || !folder) return ''
  try {
    let entries = dirCache ? dirCache.get(folder) : null
    if (!entries) {
      entries = fs.readdirSync(folder).filter((n) => SUBTITLE_EXT.test(n))
      if (dirCache) dirCache.set(folder, entries)
    }
    if (!entries.length) return ''
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
    return path.join(folder, entries[0])
  } catch (e) {
    return ''
  }
}

// 将库目录拆分为「番剧级文件夹」候选：番剧通常一个目录对应一部番
function walkFiles(root, handl) {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      continue
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        stack.push(full)
      } else if (ent.isFile() && VIDEO_EXT.test(ent.name)) {
        handl(full)
      }
    }
  }
}

// 主扫描：返回新增/更新后的番剧列表
async function scanLibrary(store, folders, settings) {
  const result = { scanned: 0, added: 0, updated: 0 }

  // 收集全部文件
  const files = []
  for (const folder of folders || []) {
    try {
      walkFiles(folder, (f) => files.push(f))
    } catch (e) {
      continue
    }
  }

  // 按 titleKey + season 分组
  const groups = new Map()
  // 字幕扫描：同目录 readdir 结果缓存，避免对同一目录重复枚举
  const dirCache = new Map()
  for (const file of files) {
    const folderName = path.basename(path.dirname(file))
    const parsed = parseFilename(path.basename(file), folderName)
    if (!parsed.number && parsed.number !== 0) continue
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

  // 合并写入
  for (const g of groups.values()) {
    g.episodes.sort((a, b) => a.number - b.number)
    let anime = store.findByTitleKey(g.titleKey)
    if (anime && Array.isArray(anime.episodes)) {
      // 更新已有番剧：合并剧集（保留原有 watched/progress）
      const existingMap = new Map(anime.episodes.map((e) => [e.number, e]))
      const episodes = g.episodes.map((ge) => {
        const old = existingMap.get(ge.number)
        const sub = settings && settings.scanSubtitle ? findSubtitle(ge.file, g.path, dirCache) : ''
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
          subtitlePath: sub || (old ? old.subtitlePath : '')
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
      if (settings && settings.autoDownload) {
        const online = await fetchOnline(g.animeTitle)
        if (online && online.title) info = { ...info, ...online }
      }
      const episodes = g.episodes.map((ge, i) => {
        const sub = settings && settings.scanSubtitle ? findSubtitle(ge.file, g.path, dirCache) : ''
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
          subtitlePath: sub
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
  if (folders && folders.length) {
    const existingFiles = new Set(files)
    const snapshot = store.list().slice()
    for (const a of snapshot) {
      const alive = (a.episodes || []).filter((e) => e.filePath && existingFiles.has(e.filePath))
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

// 重建数据库：先备份，清空再扫描，失败自动回滚（B2 修复，避免中途失败导致数据全丢）
async function rebuildDatabase(store, folders, settings) {
  const backup = JSON.parse(JSON.stringify(store.list()))
  try {
    for (const id of store.list().map((a) => a.id)) store.remove(id)
    return await scanLibrary(store, folders, settings)
  } catch (e) {
    for (const a of backup) store.upsert(a)
    throw e
  }
}

export { scanLibrary, rebuildDatabase, VIDEO_EXT }