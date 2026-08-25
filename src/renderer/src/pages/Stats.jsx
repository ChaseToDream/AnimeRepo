import { useNavigate } from 'react-router-dom'
import { useApp } from '../store/AppContext'
import { STATUS_LABEL, formatHours, formatRating, ratingSuffix, progressPct } from '../lib/format'
import Poster from '../components/Poster'
import './Stats.css'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const STATUS_COLORS = {
  watching: '#32F08C',
  completed: '#3B82F6',
  plan: '#666B75',
  onhold: '#F59E0B'
}
const STATUS_ORDER = ['watching', 'completed', 'plan', 'onhold']

// B12：按本地时区取日期 key（toISOString 是 UTC，跨时区会导致"今天凌晨看的"被算到昨天）
function toLocalDateKey(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function relativeTime(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} 天前`
  return iso.slice(0, 10)
}

export default function Stats() {
  const { library, settings } = useApp()
  const navigate = useNavigate()
  const ratingSystem = settings?.ratingSystem || '10分制'

  // —— 汇总 ——
  const total = library.length
  const watchedEpisodes = library.reduce(
    (s, a) => s + (a.episodes || []).filter((e) => e.watched).length,
    0
  )
  const totalSeconds = library.reduce(
    (s, a) => s + (a.episodes || []).reduce((n, e) => n + (e.watched && e.duration ? e.duration : 0), 0),
    0
  )
  const rated = library.filter((a) => a.rating > 0)
  const avgRating = rated.length ? rated.reduce((s, a) => s + a.rating, 0) / rated.length : 0

  // —— 近 7 天观看活动 ——
  const days = []
  const now = new Date()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(now.getDate() - i)
    days.push({ key: toLocalDateKey(d.toISOString()), label: WEEKDAYS[d.getDay()], count: 0 })
  }
  library.forEach((a) => {
    const slot = days.find((d) => d.key === toLocalDateKey(a.lastWatchedAt))
    if (slot) slot.count += 1
  })
  const maxActivity = Math.max(1, ...days.map((d) => d.count))

  // —— 观看状态分布 ——
  const statusCounts = STATUS_ORDER.map((s) => ({
    status: s,
    count: library.filter((a) => a.status === s).length
  }))
  const statusTotal = statusCounts.reduce((s, x) => s + x.count, 0)
  let acc = 0
  const segments = statusCounts.map((x) => {
    const seg = { ...x, start: acc }
    acc += x.count
    return seg
  })
  const donutBg = statusCounts
    .filter((x) => x.count > 0)
    .map((x) => {
      const start = segments.find((s) => s.status === x.status).start
      const from = statusTotal ? (start / statusTotal) * 100 : 0
      const to = statusTotal ? ((start + x.count) / statusTotal) * 100 : 0
      return `${STATUS_COLORS[x.status]} ${from}% ${to}%`
    })
    .join(', ')

  // —— 类型分布 ——
  const genreMap = {}
  library.forEach((a) => (a.genres || []).forEach((g) => { genreMap[g] = (genreMap[g] || 0) + 1 }))
  const genres = Object.entries(genreMap).sort((a, b) => b[1] - a[1]).slice(0, 6)
  const maxGenre = genres.length ? genres[0][1] : 1

  // —— 最近观看 ——
  const recent = library
    .filter((a) => a.lastWatchedAt)
    .sort((a, b) => new Date(b.lastWatchedAt) - new Date(a.lastWatchedAt))
    .slice(0, 5)

  const epText = (anime) => {
    const ep = (anime.episodes || []).find((e) => e.id === anime.lastWatchedEpisode)
    if (ep) return `第 ${ep.number} 话`
    const watched = (anime.episodes || []).filter((e) => e.watched).length
    return watched ? `已看 ${watched} 话` : '尚未观看'
  }

  // —— 评分最高 ——
  const topRated = [...rated].sort((a, b) => b.rating - a.rating).slice(0, 5)

  const poster = (a) => <Poster anime={a} as="span" />

  return (
    <div className="stats">
      <div className="ds-pagehead">
        <div className="ds-pagehead__main">
          <h1 className="ds-pagehead__title">统计面板</h1>
          <span className="ds-pagehead__count">你的番剧观看数据一览</span>
        </div>
      </div>

      <div className="stats__scroll">
        {/* 汇总卡 */}
        <div className="stats-summary">
          <div className="stats-summary-card">
            <div className="stats-summary-card__icon stats-summary-card__icon--green">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>
            </div>
            <div className="stats-summary-card__label">总番剧数</div>
            <div className="stats-summary-card__value">{total}</div>
            <div className="stats-summary-card__sub">部</div>
          </div>

          <div className="stats-summary-card">
            <div className="stats-summary-card__icon stats-summary-card__icon--blue">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            </div>
            <div className="stats-summary-card__label">已观看集数</div>
            <div className="stats-summary-card__value">{watchedEpisodes}</div>
            <div className="stats-summary-card__sub">集</div>
          </div>

          <div className="stats-summary-card">
            <div className="stats-summary-card__icon stats-summary-card__icon--purple">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon"><circle cx="12" cy="12" r="9" /><polyline points="12 6 12 12 16 14" /></svg>
            </div>
            <div className="stats-summary-card__label">观看时长</div>
            <div className="stats-summary-card__value">{formatHours(totalSeconds)}</div>
            <div className="stats-summary-card__sub">累计</div>
          </div>

          <div className="stats-summary-card">
            <div className="stats-summary-card__icon stats-summary-card__icon--amber">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" className="icon"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
            </div>
            <div className="stats-summary-card__label">平均评分</div>
            <div className="stats-summary-card__value">{formatRating(avgRating, ratingSystem)}</div>
            <div className="stats-summary-card__sub">{ratingSuffix(ratingSystem)}</div>
          </div>
        </div>

        {/* 活动 + 状态分布 */}
        <div className="stats-row stats-row--wide">
          <div className="stats-panel">
            <div className="stats-panel__header">
              <h2 className="stats-panel__title">近 7 天观看活动</h2>
              <span className="stats-panel__hint">单位：次</span>
            </div>
            <div className="stats-chart-container">
              <div className="stats-chart__yaxis">
                <span>{maxActivity}</span>
                <span>{Math.round(maxActivity / 2)}</span>
                <span>0</span>
              </div>
              <div className="stats-chart__bars">
                {days.map((d, i) => (
                  <div className="stats-chart__bar-col" key={d.key}>
                    <div className="stats-chart__bar-track">
                      <div
                        className={'stats-chart__bar' + (d.count === maxActivity && d.count > 0 ? ' stats-chart__bar--peak' : '')}
                        style={{ height: `${(d.count / maxActivity) * 100}%` }}
                        title={`${d.label}：${d.count}`}
                      />
                    </div>
                    <span className="stats-chart__day-label">{d.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="stats-panel">
            <div className="stats-panel__header">
              <h2 className="stats-panel__title">观看状态分布</h2>
            </div>
            <div className="stats-donut-container">
              <div className="stats-donut" style={donutBg ? { background: `conic-gradient(${donutBg})` } : undefined}>
                <div className="stats-donut__hole">
                  <span className="stats-donut__number">{statusTotal}</span>
                  <span className="stats-donut__label">总数</span>
                </div>
              </div>
              <div className="stats-donut__legend">
                {statusCounts.map((x) => (
                  <div className="stats-donut__legend-item" key={x.status}>
                    <span className="stats-donut__legend-dot" style={{ background: STATUS_COLORS[x.status] }} />
                    <span className="stats-donut__legend-name">{STATUS_LABEL[x.status] || x.status}</span>
                    <span className="stats-donut__legend-count">{x.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 类型分布 + 最近观看 */}
        <div className="stats-row">
          <div className="stats-panel">
            <div className="stats-panel__header">
              <h2 className="stats-panel__title">类型分布</h2>
            </div>
            <div className="stats-genre-list">
              {genres.length ? (
                genres.map(([g, count]) => (
                  <div className="stats-genre-item" key={g}>
                    <span className="stats-genre-item__label">{g}</span>
                    <div className="stats-genre-item__bar">
                      <div className="stats-genre-item__fill" style={{ width: `${(count / maxGenre) * 100}%` }} />
                    </div>
                    <span className="stats-genre-item__pct">{Math.round((count / maxGenre) * 100)}%</span>
                  </div>
                ))
              ) : (
                <div className="stats-empty">暂无类型数据</div>
              )}
            </div>
          </div>

          <div className="stats-panel">
            <div className="stats-panel__header">
              <h2 className="stats-panel__title">最近观看</h2>
              <span className="stats-panel__hint">最近 {recent.length} 部</span>
            </div>
            <div className="stats-recent-list">
              {recent.length ? (
                recent.map((a) => (
                  <div className="stats-recent-item" key={a.id} onClick={() => navigate(`/anime/${a.id}`)}>
                    <div className="stats-recent-item__thumb">{poster(a)}</div>
                    <div className="stats-recent-item__info">
                      <div className="stats-recent-item__title">{a.title}</div>
                      <div className="stats-recent-item__ep">{epText(a)}</div>
                      <div className="stats-recent-item__progress">
                        <div className="stats-recent-item__progress-fill" style={{ width: `${progressPct(a)}%` }} />
                      </div>
                    </div>
                    <span className="stats-recent-item__time">{relativeTime(a.lastWatchedAt)}</span>
                  </div>
                ))
              ) : (
                <div className="stats-empty">暂无观看记录</div>
              )}
            </div>
          </div>
        </div>

        {/* 评分最高 */}
        <div className="stats-section">
          <div className="stats-panel">
            <div className="stats-panel__header">
              <h2 className="stats-panel__title">评分最高</h2>
            </div>
            {topRated.length ? (
              <div className="stats-top-rated-grid">
                {topRated.map((a, i) => (
                  <div className="stats-top-rated-card" key={a.id} onClick={() => navigate(`/anime/${a.id}`)}>
                    <div className="stats-top-rated-card__poster">{poster(a)}</div>
                    <span className="stats-top-rated-card__rank">{i + 1}</span>
                    <span className="stats-top-rated-card__rating">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="icon"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                      {formatRating(a.rating, ratingSystem)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="stats-empty">暂无评分数据</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}