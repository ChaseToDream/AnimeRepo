// 元数据服务：离线默认资料 + 多源在线获取（Bangumi 优先，AniList 兜底）
// O-02：原先仅 AniList 单源且用原始标题直搜第一条，命中率低且无中文资料；
// 现改为：Bangumi（中文元数据最优，免鉴权）→ 相似度匹配最佳候选 → 详情补全，
// 失败再走 AniList，最后离线默认。结果（含失败）持久化到磁盘，重启不重试。

import { app } from 'electron'
import fs from 'fs'
import path from 'path'

const PALETTES = [
  ['#1a1a2e', '#16213e', '#0f3460'],
  ['#2c1810', '#4a2c2a', '#8b4513'],
  ['#1a1a2e', '#2d1b4e', '#4a1942'],
  ['#2d3436', '#636e72', '#b2bec3'],
  ['#f39c12', '#e74c3c', '#c0392b'],
  ['#4b6cb7', '#7b68ee', '#dda0dd'],
  ['#0c1445', '#1a237e', '#4a148c'],
  ['#1e3c72', '#2a5298', '#74b9ff'],
  ['#ff9a9e', '#fad0c4', '#ffecd2'],
  ['#667eea', '#764ba2', '#f093fb'],
  ['#0f0c29', '#302b63', '#24243e'],
  ['#134e5e', '#2b7a66', '#71b280']
]

function hashString(str) {
  let h = 0
  for (let i = 0; i < (str || '').length; i++) {
    h = (h << 5) - h + str.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}

// 生成一个稳定的渐变占位背景
function coverGradient(title) {
  const p = PALETTES[hashString(title) % PALETTES.length]
  return `linear-gradient(135deg, ${p[0]} 0%, ${p[1]} 50%, ${p[2]} 100%)`
}

// 离线默认资料
function offlineDefaults(title, season, count) {
  return {
    title,
    description: '',
    genres: [],
    year: new Date().getFullYear(),
    airDate: '',
    studio: '',
    voiceActors: [],
    coverUrl: '',
    coverGradient: coverGradient(title),
    seasonCount: 1,
    aired: count,
    votes: 0
  }
}

// ===== O-02：多源在线元数据 =====

const FETCH_TIMEOUT = 10000
// Bangumi API 要求自定义 User-Agent（官方约定，避免被拒绝服务）
const BANGUMI_UA = 'AnimeRepo/1.0 (local anime library manager)'
const BANGUMI_API = 'https://api.bgm.tv'
const ANILIST_API = 'https://graphql.anilist.co'

// 会话内内存缓存
const onlineCache = new Map()

// —— 磁盘缓存：成功结果永久保留，失败结果 24h 内不重试 ——
const FAIL_TTL = 24 * 60 * 60 * 1000
let diskCache = null
let diskCacheSaveTimer = null

function diskCacheFile() {
  return path.join(app.getPath('userData'), 'metadata-cache.json')
}

function loadDiskCache() {
  if (diskCache) return
  diskCache = {}
  try {
    const raw = JSON.parse(fs.readFileSync(diskCacheFile(), 'utf-8'))
    if (raw && typeof raw === 'object') {
      // 加载时顺带清理过期失败记录
      const now = Date.now()
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v === 'object' && (!v.f || now - (v.at || 0) < FAIL_TTL)) {
          diskCache[k] = v
        }
      }
    }
  } catch (e) {
    /* 无缓存或损坏：忽略 */
  }
}

function scheduleDiskCacheSave() {
  if (diskCacheSaveTimer) return
  diskCacheSaveTimer = setTimeout(() => {
    diskCacheSaveTimer = null
    try {
      // 上限保护：超过 5000 条时按时间淘汰最旧的一半
      const keys = Object.keys(diskCache)
      if (keys.length > 5000) {
        keys
          .sort((a, b) => (diskCache[a].at || 0) - (diskCache[b].at || 0))
          .slice(0, Math.floor(keys.length / 2))
          .forEach((k) => delete diskCache[k])
      }
      const payload = JSON.stringify(diskCache)
      fs.writeFile(diskCacheFile(), payload, 'utf-8', () => {})
    } catch (e) {
      /* 保存失败不影响流程 */
    }
  }, 1000)
}

function cachePut(key, result) {
  const entry = { r: result, f: !result, at: Date.now() }
  onlineCache.set(key, entry)
  loadDiskCache()
  diskCache[key] = entry
  scheduleDiskCacheSave()
}

// 失效的失败记录（超过 TTL）不拦截重试
function cacheGet(key) {
  const mem = onlineCache.get(key)
  if (mem) {
    if (!mem.f || Date.now() - mem.at < FAIL_TTL) return mem
  }
  loadDiskCache()
  const disk = diskCache[key]
  if (disk) {
    if (!disk.f || Date.now() - disk.at < FAIL_TTL) return disk
  }
  return null
}

// 标题规范化：小写 + 去空白/标点/括号，用于相似度比对
function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_：:，,。.!！?？·【】\[\]()（）'"~～&/\\]+/g, '')
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// Bangumi infobox 值兼容字符串 / 数组两种形态（v0 API 的 ValueItem 数组）
function infoboxValue(infobox, keys) {
  if (!Array.isArray(infobox)) return ''
  for (const key of keys) {
    const item = infobox.find((x) => x && x.key === key)
    if (!item) continue
    if (typeof item.value === 'string') return item.value
    if (Array.isArray(item.value)) {
      const text = item.value.map((v) => (v && typeof v === 'object' ? v.v : v)).filter(Boolean).join(' / ')
      if (text) return text
    }
  }
  return ''
}

// Bangumi：搜索候选 → 相似度择优 → 详情补全
// 返回与 AniList 结果同构的对象；无把握匹配（相似度为 0）时返回 null 走下一源
async function fetchBangumi(title) {
  const res = await fetchWithTimeout(
    `${BANGUMI_API}/search/subject/${encodeURIComponent(title)}?type=2&max_results=5`,
    { headers: { 'User-Agent': BANGUMI_UA, Accept: 'application/json' } }
  )
  if (!res.ok) return null
  const json = await res.json()
  const list = json && Array.isArray(json.list) ? json.list : []
  if (!list.length) return null
  // 相似度匹配：精确 = 100，包含 = 60；两者皆无 → 放弃（避免字幕组译名误配到热门番）
  const target = normalizeTitle(title)
  let best = null
  let bestScore = 0
  for (const item of list) {
    let score = 0
    for (const n of [item.name_cn, item.name]) {
      if (!n) continue
      const nn = normalizeTitle(n)
      if (!nn) continue
      if (nn === target) score = Math.max(score, 100)
      else if (nn.includes(target) || target.includes(nn)) score = Math.max(score, 60)
    }
    if (score > bestScore) {
      bestScore = score
      best = item
    }
  }
  if (!best || bestScore <= 0) return null
  // 详情请求补全 tags / 工作室 / 评分（失败不阻断，用搜索结果字段兜底）
  let detail = null
  try {
    const dres = await fetchWithTimeout(`${BANGUMI_API}/v0/subjects/${best.id}`, {
      headers: { 'User-Agent': BANGUMI_UA, Accept: 'application/json' }
    })
    if (dres.ok) detail = await dres.json()
  } catch (e) {
    /* 详情失败：使用搜索结果字段 */
  }
  const src = detail || best
  const images = src.images || best.images || {}
  const date = (detail && detail.date) || best.air_date || ''
  return {
    title: best.name_cn || best.name || title,
    englishTitle: '',
    romaji: best.name || '',
    description: String((detail && detail.summary) || best.summary || '').slice(0, 500),
    genres: (detail && Array.isArray(detail.tags)
      ? detail.tags
          .slice()
          .sort((a, b) => (b.count || 0) - (a.count || 0))
          .map((t) => t.name)
          .slice(0, 6)
      : []
    ),
    year: parseInt(String(date).slice(0, 4), 10) || 0,
    airDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    studio: infoboxValue(detail && detail.infobox, ['动画制作', '制作']),
    voiceActors: [],
    coverUrl: images.large || images.common || '',
    averageScore: (best.rating && best.rating.score) || 0
  }
}

// AniList GraphQL（免密钥），作为 Bangumi 之后的兜底源
async function fetchAniList(title) {
  const query = `
  query ($search: String) {
    Media(search: $search, type: ANIME) {
      title { romaji english native }
      description(asHtml: false)
      genres
      coverImage { extraLarge large }
      bannerImage
      startDate { year month day }
      studios(isMain: true) { nodes { name } }
      averageScore
      characters(perPage: 5, role: MAIN) { nodes { name { full } } }
      seasonYear
      season
    }
  }`
  const res = await fetchWithTimeout(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables: { search: title } })
  })
  if (!res.ok) return null
  const json = await res.json()
  const m = json && json.data && json.data.Media
  if (!m) return null
  const voiceActors = m.characters && m.characters.nodes
    ? m.characters.nodes.map((c) => c.name && c.name.full).filter(Boolean)
    : []
  return {
    title: m.title && (m.title.native || m.title.chinese || m.title.romaji || m.title.english) || title,
    englishTitle: (m.title && m.title.romaji) || (m.title && m.title.english) || '',
    romaji: (m.title && m.title.romaji) || '',
    description: m.description ? stripHtml(m.description).slice(0, 500) : '',
    genres: m.genres || [],
    year: m.startDate && m.startDate.year,
    airDate: m.startDate && m.startDate.year
      ? `${m.startDate.year}-${String(m.startDate.month || 0).padStart(2, '0')}-${String(m.startDate.day || 0).padStart(2, '0')}`
      : '',
    studio: m.studios && m.studios.nodes && m.studios.nodes.length ? m.studios.nodes[0].name : '',
    voiceActors,
    coverUrl: m.coverImage && (m.coverImage.extraLarge || m.coverImage.large) || '',
    averageScore: m.averageScore || 0
  }
}

// 在线获取：Bangumi（中文优先）→ AniList 兜底；失败返回 null。
// 内存 + 磁盘双层缓存：同一标题会话内不重复请求；失败 24h 内不重试，成功永久缓存。
// O-2：force=true 时跳过缓存强制重查（元数据手动刷新用），新结果覆盖旧缓存。
async function fetchOnline(title, { force } = {}) {
  const cacheKey = (title || '').trim().toLowerCase()
  if (!cacheKey) return null
  if (!force) {
    const cached = cacheGet(cacheKey)
    if (cached) return cached.r
  }
  let result = null
  try {
    result = await fetchBangumi(title)
  } catch (e) {
    result = null
  }
  if (!result || !result.title) {
    try {
      result = await fetchAniList(title)
    } catch (e) {
      result = null
    }
  }
  if (result && !result.title) result = null
  cachePut(cacheKey, result)
  return result
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
}

// ===== N-01：追番日历（AniList AiringSchedule）=====
// 按标题查询单部番剧的下一集放送时间；独立内存缓存 + 10 分钟 TTL
// （放送时间基本固定，短 TTL 仅为跨天滚动「下一集」）
const airingCache = new Map()
const AIRING_TTL = 10 * 60 * 1000

export async function fetchAiringSchedule(title) {
  const key = (title || '').trim().toLowerCase()
  if (!key) return null
  const cached = airingCache.get(key)
  if (cached && Date.now() - cached.at < AIRING_TTL) return cached.r
  const query = `
  query ($search: String) {
    Media(search: $search, type: ANIME) {
      id
      title { native romaji english }
      coverImage { large }
      status
      nextAiringEpisode { episode airingAt }
    }
  }`
  let result = null
  try {
    const res = await fetchWithTimeout(ANILIST_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { search: title } })
    })
    if (res.ok) {
      const json = await res.json()
      const m = json && json.data && json.data.Media
      if (m) {
        // 相似度匹配：搜索返回第一条可能不是目标番（同 O-02 的防误配策略）
        const target = normalizeTitle(title)
        const names = [m.title && m.title.native, m.title && m.title.romaji, m.title && m.title.english]
        const matched = names.some((n) => {
          if (!n) return false
          const nn = normalizeTitle(n)
          return nn === target || nn.includes(target) || target.includes(nn)
        })
        if (matched) {
          result = {
            anilistId: m.id,
            coverUrl: (m.coverImage && m.coverImage.large) || '',
            status: m.status || '',
            nextEpisode: m.nextAiringEpisode ? m.nextAiringEpisode.episode : null,
            airingAt: m.nextAiringEpisode ? m.nextAiringEpisode.airingAt * 1000 : null // s → ms
          }
        }
      }
    }
  } catch (e) {
    result = null
  }
  airingCache.set(key, { r: result, at: Date.now() })
  return result
}

export { offlineDefaults, fetchOnline, coverGradient }
