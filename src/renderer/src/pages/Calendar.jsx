// 追番日历（N-01）：库内「正在观看」番剧的放送时间表。
// 数据源：AniList AiringSchedule（主进程 10min 缓存 + 相似度防误配）；
// 网络不可达时降级提示，不阻塞页面。
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../store/AppContext'
import './Calendar.css'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function fmtTime(ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 放送时间相对描述：<0 已播出 / 分钟级 / 小时级 / 天级
function fmtCountdown(ts, now) {
  const diff = ts - now
  if (diff <= 0) return '已播出'
  const min = Math.floor(diff / 60000)
  if (min < 60) return `${min} 分钟后`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} 小时后`
  return `${Math.floor(h / 24)} 天后`
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function Calendar() {
  const { library } = useApp()
  const navigate = useNavigate()
  const [state, setState] = useState({ loading: true, ok: true, items: [] })
  // B-8：手动重试计数（失败后可点击重试，无需离开页面重新进入）
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true }))
    window.api.fetchCalendar().then((res) => {
      if (cancelled) return
      setState({ loading: false, ok: !!(res && res.ok), items: (res && res.items) || [] })
    }).catch(() => {
      if (!cancelled) setState({ loading: false, ok: false, items: [] })
    })
    return () => { cancelled = true }
  }, [library.length, attempt])

  const now = Date.now()
  // 近 7 天（含今天）按日分组；无放送时间（已完结/查询失败）的番单独归组
  const days = useMemo(() => {
    const list = []
    const today = new Date()
    for (let i = 0; i < 7; i++) {
      const d = new Date(today)
      d.setDate(today.getDate() + i)
      list.push({ key: dateKey(d), label: WEEKDAYS[d.getDay()], date: d, items: [] })
    }
    const unscheduled = []
    for (const it of state.items) {
      if (!it.airingAt) { unscheduled.push(it); continue }
      const d = new Date(it.airingAt)
      const slot = list.find((x) => x.key === dateKey(d))
      if (slot && it.airingAt >= today.setHours(0, 0, 0, 0)) slot.items.push(it)
      else if (it.airingAt < now) unscheduled.push(it) // 早于今天的归入无档期
    }
    return { list, unscheduled }
  }, [state.items, now])

  const watchingCount = library.filter((a) => a.status === 'watching').length

  return (
    <div className="calendar">
      <div className="ds-pagehead">
        <div className="ds-pagehead__main">
          <h1 className="ds-pagehead__title">追番日历</h1>
          <span className="ds-pagehead__count">正在追 {watchingCount} 部 · 近 7 天放送表</span>
        </div>
      </div>

      <div className="calendar__scroll">
        {state.loading ? (
          <div className="calendar-empty">正在获取放送时间…</div>
        ) : watchingCount === 0 ? (
          <div className="calendar-empty">
            <div className="calendar-empty__title">还没有在追的番</div>
            <div className="calendar-empty__desc">把想追的番标记为「正在观看」，这里会显示它们的更新时间表。</div>
          </div>
        ) : (
          <>
            {!state.ok && (
              <div className="calendar-warn">
                部分或全部放送时间获取失败（网络不可达），稍后打开此页会自动重试。
                <button
                  className="ds-btn ds-btn--sm ds-btn--secondary"
                  style={{ marginLeft: 8 }}
                  onClick={() => setAttempt((a) => a + 1)}
                >
                  重试
                </button>
              </div>
            )}
            <div className="calendar-grid">
              {days.list.map((day, i) => (
                <section
                  className={'calendar-day' + (i === 0 ? ' is-today' : '') + (day.items.length ? ' has-items' : '')}
                  key={day.key}
                >
                  <div className="calendar-day__head">
                    <span className="calendar-day__label">{i === 0 ? '今天' : day.label}</span>
                    <span className="calendar-day__date">{day.date.getMonth() + 1}/{day.date.getDate()}</span>
                  </div>
                  <div className="calendar-day__list">
                    {day.items.length === 0 ? (
                      <div className="calendar-day__none">—</div>
                    ) : (
                      day.items.map((it) => (
                        <div
                          className="calendar-show"
                          key={it.animeId}
                          onClick={() => navigate(`/anime/${it.animeId}`)}
                        >
                          <div className="calendar-show__time">{fmtTime(it.airingAt)}</div>
                          <div className="calendar-show__info">
                            <div className="calendar-show__title">{it.title}</div>
                            <div className="calendar-show__meta">
                              {it.nextEpisode ? `第 ${it.nextEpisode} 话 · ` : ''}
                              {fmtCountdown(it.airingAt, now)}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </section>
              ))}
            </div>
            {days.unscheduled.length > 0 && (
              <section className="calendar-unscheduled">
                <div className="calendar-unscheduled__title">暂无放送信息（已完结或未匹配）</div>
                <div className="calendar-unscheduled__list">
                  {days.unscheduled.map((it) => (
                    <span
                      className="ds-tag ds-tag--neutral-strong calendar-unscheduled__tag"
                      key={it.animeId}
                      onClick={() => navigate(`/anime/${it.animeId}`)}
                    >
                      {it.title}
                    </span>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
