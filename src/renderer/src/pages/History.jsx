// 观看历史时间线（N-04）：基于观看日志（O-04）按日期分组展示，
// 每条记录 = 看完一集（自动标记/手动标记/批量标记的瞬间）
import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../store/AppContext'
import { formatTime, coverGradient } from '../lib/format'
import './History.css'

// 日期分组的分组头文案（今天 / 昨天 / MM月DD日）
function dayLabel(key) {
  const today = new Date()
  const t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  const yk = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`
  if (key === t) return '今天'
  if (key === yk) return '昨天'
  const [, m, d] = key.split('-')
  return `${Number(m)}月${Number(d)}日`
}

export default function History() {
  const { history, loadHistory, getAnime } = useApp()
  const navigate = useNavigate()

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  // 按本地日期分组（保持新的在前）
  const groups = useMemo(() => {
    const map = new Map()
    for (const h of history) {
      const d = new Date(h.watchedAt)
      if (isNaN(d.getTime())) continue
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(h)
    }
    return [...map.entries()]
  }, [history])

  // 每日汇总（集数 + 时长）
  const dayTotal = (list) => {
    const eps = list.length
    const secs = list.reduce((s, h) => s + (h.seconds || 0), 0)
    return eps ? `${eps} 集${secs ? ` · ${formatTime(secs)}` : ''}` : ''
  }

  return (
    <div className="history">
      <div className="ds-pagehead">
        <div className="ds-pagehead__main">
          <h1 className="ds-pagehead__title">观看历史</h1>
          <span className="ds-pagehead__count">最近 {history.length} 条</span>
        </div>
      </div>

      <div className="history__scroll">
        {history.length === 0 ? (
          <div className="history-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <polyline points="12 7 12 12 16 14" />
            </svg>
            <div className="history-empty__title">暂无观看记录</div>
            <div className="history-empty__desc">看完一集后会自动记录在这里（保留最近 500 条）。</div>
          </div>
        ) : (
          groups.map(([key, list]) => (
            <section className="history-group" key={key}>
              <div className="history-group__head">
                <span className="history-group__day">{dayLabel(key)}</span>
                <span className="history-group__total">{dayTotal(list)}</span>
              </div>
              <div className="history-group__list">
                {list.map((h) => {
                  const anime = getAnime(h.animeId)
                  const cover = anime ? anime.coverUrl : ''
                  const grad = anime ? anime.coverGradient || coverGradient(anime.title) : coverGradient(h.animeTitle)
                  const time = new Date(h.watchedAt)
                  const hh = String(time.getHours()).padStart(2, '0')
                  const mm = String(time.getMinutes()).padStart(2, '0')
                  return (
                    <div
                      className="history-item"
                      key={h.id}
                      onClick={() => h.animeId && navigate(`/anime/${h.animeId}`)}
                    >
                      <div className="history-item__thumb" style={{ background: cover ? 'none' : grad }}>
                        {cover ? <img src={cover} alt="" loading="lazy" /> : null}
                      </div>
                      <div className="history-item__main">
                        <div className="history-item__title">{h.animeTitle}</div>
                        <div className="history-item__meta">
                          {/* N-4：未识别文件（number=0）不显示「第 ? 话」 */}
                          {h.epNumber > 0 ? `第 ${h.epNumber} 话` : '未分类剧集'}
                          {h.seconds ? ` · ${formatTime(h.seconds)}` : ''}
                        </div>
                      </div>
                      <span className="history-item__time">{hh}:{mm}</span>
                    </div>
                  )
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  )
}
