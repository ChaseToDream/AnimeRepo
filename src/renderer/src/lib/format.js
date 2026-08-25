// 通用格式化与状态映射工具

export const STATUS_LABEL = {
  watching: '正在观看',
  completed: '已完成',
  plan: '想看',
  onhold: '搁置'
}

export const STATUS_TAG_CLASS = {
  watching: 'ds-tag--brand',
  completed: 'ds-tag--success',
  plan: 'ds-tag--warning',
  onhold: ''
}

// 秒 → mm:ss 或 h:mm:ss
export function formatTime(secs) {
  if (!secs || isNaN(secs) || secs < 0) return '00:00'
  const s = Math.floor(secs % 60)
  const m = Math.floor((secs / 60) % 60)
  const h = Math.floor(secs / 3600)
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// 秒 → "1小时23分" 用于时长统计
export function formatHours(secs) {
  const hours = secs / 3600
  if (hours >= 1) return hours.toFixed(1) + 'h'
  return Math.round(secs / 60) + 'min'
}

// 集数徽章文本
export function episodeBadge(anime) {
  if (!anime || !Array.isArray(anime.episodes)) return 'EP 0/0'
  const total = anime.episodes.length
  // P6：不用 Math.max(...map) 展开——单个番剧剧集数超过 ~6.5 万时（如把媒体库指向
  // 存放大量无法解析文件的目录，全部归入同一个「未知番剧」）展开会抛 RangeError，
  // 渲染期异常同样导致整棵树卸载白屏
  let current = 0
  for (const e of anime.episodes) {
    if (e.watched && e.number > current) current = e.number
  }
  const isMovie = total === 1
  if (isMovie) return '剧场版'
  const lastWatched = anime.episodes.filter((e) => e.watched).length
  return `EP ${lastWatched}/${total}`
}

// 观看进度百分比（基于剧集已看情况）
export function progressPct(anime) {
  if (!anime || !Array.isArray(anime.episodes) || !anime.episodes.length) return 0
  const watched = anime.episodes.filter((e) => e.watched).length
  return Math.round((watched / anime.episodes.length) * 100)
}

// 当前延续观看的剧集
export function nextEpisode(anime) {
  if (!anime || !Array.isArray(anime.episodes) || !anime.episodes.length) return null
  const sorted = [...anime.episodes].sort((a, b) => a.number - b.number)
  // B8：全部已看时返回 null（不再错误指向最后一集）
  if (sorted.every((e) => e.watched)) return null
  // 优先返回有播放进度但未看完的剧集（断点续看）
  const current = sorted.find((e) => !e.watched && e.progress > 0)
  if (current) return current
  // 否则返回第一个未观看的剧集
  return sorted.find((e) => !e.watched) || null
}

// 视频文件 → anime:// 播放地址
export function videoUrl(filePath) {
  return window.api?.toVideoUrl?.(filePath) || ''
}

// 生成稳定占位色（与主进程 coverGradient 对应）
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

export function coverGradient(title) {
  const p = PALETTES[hashString(title) % PALETTES.length]
  return `linear-gradient(135deg, ${p[0]} 0%, ${p[1]} 50%, ${p[2]} 100%)`
}

export function shortDate(iso, format) {
  if (!iso) return ''
  // 默认 YYYY-MM-DD（原实现直接截取，保持兼容）；仅 DD/MM/YYYY 与 MM/DD/YYYY 需重新组合
  if (format !== 'DD/MM/YYYY' && format !== 'MM/DD/YYYY') return iso.slice(0, 10)
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso.slice(0, 10)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return format === 'DD/MM/YYYY' ? `${day}/${m}/${y}` : `${m}/${day}/${y}`
}

// 评分显示值（按评分制式换算）：10分制保持原值、5星制折半、百分制乘 10
export function formatRating(rating, system) {
  const r = Number(rating) || 0
  if (!r) return '—'
  if (system === '5星制') return (r / 2).toFixed(1)
  if (system === '百分制') return String(Math.round(r * 10))
  return r.toFixed(1)
}

// 评分制式后缀
export function ratingSuffix(system) {
  if (system === '5星制') return '/5'
  if (system === '百分制') return '/100'
  return '/10'
}