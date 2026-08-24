// 媒体扫描服务：递归扫描库文件夹，识别视频文件并解析出番剧/剧集
import fs from 'fs'
import path from 'path'
import { parseFilename, titleKey } from './parser'
import { offlineDefaults, fetchOnline } from './metadata'

const VIDEO_EXT = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|rmvb|rm)$/i

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
          subtitlePath: old ? old.subtitlePath : ''
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
      const episodes = g.episodes.map((ge, i) => ({
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
        subtitlePath: ''
      }))
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

  return { ...result, animes: store.list() }
}

// 重建数据库：清空再扫描
async function rebuildDatabase(store, folders, settings) {
  for (const id of store.list().map((a) => a.id)) store.remove(id)
  return scanLibrary(store, folders, settings)
}

export { scanLibrary, rebuildDatabase, VIDEO_EXT }