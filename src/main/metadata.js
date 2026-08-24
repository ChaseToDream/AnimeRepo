// 元数据服务：离线默认资料 + 可选的在线资料获取（失败优雅降级）

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

// 在线获取：AniList GraphQL（免密钥）。失败返回 null。
async function fetchOnline(title) {
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
  try {
    const res = await fetch('https://graphql.anilist.co', {
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
  } catch (e) {
    return null
  }
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
}

export { offlineDefaults, fetchOnline, coverGradient }