import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../store/AppContext'
import {
  STATUS_LABEL,
  STATUS_TAG_CLASS,
  formatHours,
  episodeBadge,
  progressPct,
  nextEpisode
} from '../lib/format'
import Poster from '../components/Poster'
import './Library.css'

const VIEW_TABS = [
  ['grid', '网格', <rect key="g" x="3" y="3" width="7" height="7" rx="1.5" />, <rect key="g2" x="14" y="3" width="7" height="7" rx="1.5" />, <rect key="g3" x="3" y="14" width="7" height="7" rx="1.5" />, <rect key="g4" x="14" y="14" width="7" height="7" rx="1.5" />],
  ['list', '列表', <line key="l1" x1="9" y1="6" x2="21" y2="6" />, <line key="l2" x1="9" y1="12" x2="21" y2="12" />, <line key="l3" x1="9" y1="18" x2="21" y2="18" />, <rect key="l4" x="3" y="4" width="3" height="3" rx="0.5" />, <rect key="l5" x="3" y="10" width="3" height="3" rx="0.5" />, <rect key="l6" x="3" y="16" width="3" height="3" rx="0.5" />]
]

function PlayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon">
      <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none" />
    </svg>
  )
}

export default function Library({ filter, setFilter }) {
  const { library, scan, scanning } = useApp()
  const navigate = useNavigate()
  const [view, setView] = useState('grid')

  const q = (filter.query || '').trim().toLowerCase()
  const items = library.filter((a) => {
    if (filter.status && filter.status !== 'all' && a.status !== filter.status) return false
    if (filter.genre && !(a.genres || []).includes(filter.genre)) return false
    if (q) {
      const title = (a.title || '').toLowerCase()
      const desc = (a.description || '').toLowerCase()
      if (!title.includes(q) && !desc.includes(q)) return false
    }
    return true
  })

  // 全局统计（基于整个媒体库）
  const stats = {
    total: library.length,
    watching: library.filter((a) => a.status === 'watching').length,
    completed: library.filter((a) => a.status === 'completed').length,
    hours: library.reduce(
      (s, a) => s + (a.episodes || []).reduce((n, e) => n + (e.duration || 0), 0),
      0
    )
  }

  const pageTitle =
    filter.status && filter.status !== 'all' ? STATUS_LABEL[filter.status] || '全部番剧' : '全部番剧'

  const handlePlay = (e, a) => {
    e.stopPropagation()
    const ep = nextEpisode(a)
    if (ep) navigate(`/player/${a.id}/${ep.id}`)
  }

  return (
    <div className="library">
      <div className="ds-pagehead">
        <div className="ds-pagehead__main">
          <h1 className="ds-pagehead__title">{pageTitle}</h1>
          <span className="ds-pagehead__count">{items.length} 部</span>
        </div>
        <div className="ds-pagehead__actions">
          <div className="ds-tabs ds-tabs--filled">
            {VIEW_TABS.map(([key, label, ...paths]) => (
              <button
                key={key}
                className={'ds-tab' + (view === key ? ' is-active' : '')}
                onClick={() => setView(key)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="icon">
                  {paths}
                </svg>
                {label}
              </button>
            ))}
          </div>

          <button className="ds-btn ds-btn--secondary ds-btn--sm">
            <span>按添加时间</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="icon">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          <button
            className="ds-btn ds-btn--brand ds-btn--sm"
            onClick={() => scan()}
            disabled={scanning}
            style={scanning ? { opacity: 0.6, cursor: 'default' } : undefined}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="icon">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <polyline points="21 3 21 9 15 9" />
            </svg>
            {scanning ? '扫描中…' : '扫描媒体库'}
          </button>
        </div>
      </div>

      <div className="library__scroll">
        {library.length === 0 ? (
          <div className="library-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="library-empty__icon">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <div className="library-empty__title">请添加媒体库并扫描</div>
            <div className="library-empty__desc">在设置中添加媒体库文件夹，或点击「扫描媒体库」开始导入番剧。</div>
            <button className="ds-btn ds-btn--brand" onClick={() => navigate('/settings')}>
              前往设置
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="library-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="library-empty__icon">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.5" y2="16.5" />
            </svg>
            <div className="library-empty__title">没有匹配的番剧</div>
            <div className="library-empty__desc">尝试调整筛选条件或搜索关键词，或者扫描媒体库以导入更多番剧。</div>
            <button className="ds-btn ds-btn--brand" onClick={() => scan()}>
              {scanning ? '扫描中…' : '扫描媒体库'}
            </button>
          </div>
        ) : (
          <>
            <div className="library__stats">
              <div className="ds-statcard">
                <span className="ds-statcard__label">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                  </svg>
                  总番剧数
                </span>
                <span className="ds-statcard__value">{stats.total}</span>
              </div>
              <div className="ds-statcard">
                <span className="ds-statcard__label">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  正在观看
                </span>
                <span className="ds-statcard__value">{stats.watching}</span>
              </div>
              <div className="ds-statcard">
                <span className="ds-statcard__label">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="icon">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                  已完成
                </span>
                <span className="ds-statcard__value">{stats.completed}</span>
              </div>
              <div className="ds-statcard">
                <span className="ds-statcard__label">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon">
                    <circle cx="12" cy="12" r="9" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  总时长
                </span>
                <span className="ds-statcard__value">{formatHours(stats.hours)}</span>
              </div>
            </div>

            {view === 'grid' ? (
              <div className="anime-grid">
                {items.map((a) => (
                  <article className="anime-card" key={a.id} onClick={() => navigate(`/anime/${a.id}`)}>
                    <div className="anime-card__poster">
                      <Poster anime={a} imgClassName="anime-card__poster-img" bgClassName="anime-card__poster-bg" />
                      <div className="anime-card__tags">
                        <span className={'ds-tag ' + (STATUS_TAG_CLASS[a.status] || '')}>
                          {STATUS_LABEL[a.status] || a.status}
                        </span>
                      </div>
                      <span
                        className={
                          'anime-card__progress-badge' +
                          (a.status === 'completed'
                            ? ' anime-card__progress-badge--completed'
                            : a.status === 'plan'
                              ? ' anime-card__progress-badge--plan'
                              : '')
                        }
                      >
                        {episodeBadge(a)}
                      </span>
                      <div className="anime-card__overlay">
                        <div className="anime-card__title">{a.title}</div>
                        <div className="anime-card__meta">
                          <div className="anime-card__rating">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="icon">
                              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                            </svg>
                            {a.rating || '—'}
                          </div>
                          <span className="anime-card__genres">{(a.genres || []).slice(0, 2).join('/')}</span>
                        </div>
                      </div>
                      <div className="anime-card__progress-bar">
                        <div className="anime-card__progress-fill" style={{ width: progressPct(a) + '%' }} />
                      </div>
                      <div className="anime-card__play-overlay" onClick={(e) => handlePlay(e, a)}>
                        <div className="anime-card__play-btn">
                          <PlayIcon />
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="anime-list-wrap">
                <div className="anime-list">
                  <div className="anime-list__header">
                    <span>#</span>
                    <span>封面</span>
                    <span>标题</span>
                    <span>类型</span>
                    <span>状态</span>
                    <span>进度</span>
                    <span>评分</span>
                  </div>
                  {items.map((a, i) => (
                    <div className="anime-list__row" key={a.id} onClick={() => navigate(`/anime/${a.id}`)}>
                      <span className="anime-list__index">{i + 1}</span>
                      <div className="anime-list__thumb">
                        <Poster anime={a} as="span" />
                      </div>
                      <span className="anime-list__title">{a.title}</span>
                      <div className="anime-list__genres">
                        {(a.genres || []).slice(0, 2).map((g) => (
                          <span className="ds-tag ds-tag--neutral-strong" key={g}>{g}</span>
                        ))}
                      </div>
                      <span className={'ds-tag ' + (STATUS_TAG_CLASS[a.status] || '')}>
                        {STATUS_LABEL[a.status] || a.status}
                      </span>
                      <div className="anime-list__bar">
                        <div className="anime-list__bar-fill" style={{ width: progressPct(a) + '%' }} />
                      </div>
                      <div className="anime-list__rating">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="icon">
                          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                        {a.rating || '—'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}