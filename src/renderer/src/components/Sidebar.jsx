import { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../store/AppContext'
import { STATUS_LABEL, STATUS_TAG_CLASS } from '../lib/format'
import api from '../lib/api'

// 侧边导航：用于番剧库/统计/历史/日历/设置等带完整外壳的页面
export default function Sidebar({ activeFilter, onFilterChange }) {
  const { library, settings, addFolder, refresh, t, showToast, scan } = useApp()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [section, setSection] = useState('library')
  const searchInputRef = useRef(null)

  // UX-05：Ctrl+F / Cmd+F 全局聚焦搜索框
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyF' || e.key === 'f')) {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // UX-05：一键清空搜索
  const clearQuery = () => {
    setQuery('')
    onFilterChange?.(activeFilter, '')
    searchInputRef.current?.focus()
  }

  // O-8/P-10：计数 useMemo 化——Library 任何变更都会触发 Sidebar 重渲染，
  // 原先每次渲染全库 filter/reduce 计算状态数、流派计数与标签列表（大库开销明显）。
  const statusCounts = useMemo(() => {
    const m = { all: library.length, watching: 0, completed: 0, plan: 0, onhold: 0 }
    for (const a of library) {
      if (a.status in m) m[a.status] += 1
    }
    return m
  }, [library])
  const { genreCounts, genreSet } = useMemo(() => {
    const counts = {}
    for (const a of library) {
      for (const g of a.genres || []) counts[g] = (counts[g] || 0) + 1
    }
    return { genreCounts: counts, genreSet: Object.keys(counts) }
  }, [library])
  const tagList = useMemo(() => {
    const counts = {}
    for (const a of library) {
      for (const t of a.tags || []) counts[t] = (counts[t] || 0) + 1
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])
  }, [library])

  const navigateTo = (route) => navigate(route)

  const handleMediaOpen = async () => {
    const folders = await addFolder()
    if (folders && folders.length) {
      showToast('已添加媒体库文件夹，开始扫描…', 'success')
      scan()
    }
    refresh()
  }

  return (
    <aside className="ds-sidebar">
      <nav className="ds-navlist">
        <div className="ds-navlist__search">
          <div className="ds-input ds-navlist__search-box">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="ds-input__icon">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.5" y2="16.5" />
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t('nav.search')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                onFilterChange?.(activeFilter, e.target.value)
              }}
            />
            {/* UX-05：有输入时显示一键清空按钮 */}
            {query && (
              <button className="ds-navlist__search-clear" aria-label="清空搜索" onClick={clearQuery}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            )}
          </div>
        </div>

        <div className="ds-navlist__group">
          <div className="ds-navlist__group-title">{t('nav.myGroup')}</div>
          {[['all', statusCounts.all], ['watching', statusCounts.watching], ['completed', statusCounts.completed], ['plan', statusCounts.plan], ['onhold', statusCounts.onhold]].map(([key, count]) => (
            <button
              key={key}
              className={
                'ds-navlist__item ' + (activeFilter === key && section === 'library' ? 'is-active' : '')
              }
              onClick={() => {
                setSection('library')
                navigate('/')
                onFilterChange?.(key)
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon">
                {key === 'watching' ? <polygon points="5 3 19 12 5 21 5 3" /> : key === 'all' ? <rect x="3" y="3" width="18" height="18" rx="2" /> : <circle cx="12" cy="12" r="9" />}
              </svg>
              <span className="ds-navlist__label">{t(`nav.${key}`)}</span>
              <span className="ds-navlist__badge">{count}</span>
            </button>
          ))}
        </div>

        <div className="ds-navlist__group">
          <div className="ds-navlist__group-title">{t('nav.browse')}</div>
          <button
            className={'ds-navlist__item ' + (activeFilter === 'stats' || (section === 'stats') ? 'is-active' : '')}
            onClick={() => {
              setSection('stats')
              navigate('/stats')
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon">
              <line x1="4" y1="20" x2="20" y2="20" /><line x1="6" y1="20" x2="6" y2="10" /><line x1="11" y1="20" x2="11" y2="4" /><line x1="16" y1="20" x2="16" y2="13" />
            </svg>
            <span className="ds-navlist__label">{t('nav.stats')}</span>
          </button>
          {/* N-01：追番日历入口 */}
          <button
            className={'ds-navlist__item ' + (section === 'calendar' ? 'is-active' : '')}
            onClick={() => {
              setSection('calendar')
              navigate('/calendar')
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="icon">
              <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
            <span className="ds-navlist__label">追番日历</span>
          </button>
          {/* N-04：观看历史入口 */}
          <button
            className={'ds-navlist__item ' + (section === 'history' ? 'is-active' : '')}
            onClick={() => {
              setSection('history')
              navigate('/history')
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="icon">
              <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 16 14" />
            </svg>
            <span className="ds-navlist__label">观看历史</span>
          </button>
          <button
            className={'ds-navlist__item ' + (activeFilter === 'recent' && section === 'library' ? 'is-active' : '')}
            onClick={() => {
              setSection('library')
              navigate('/')
              onFilterChange?.('recent')
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon">
              <polygon points="12 2 2 7 12 12 22 7 12 2" /><path d="M2 17 12 22l10-5" /><path d="M2 12l10 5 10-5" />
            </svg>
            <span className="ds-navlist__label">{t('nav.recent')}</span>
          </button>
        </div>

        <div className="ds-navlist__group">
          <div className="ds-navlist__group-title">{t('nav.category')}</div>
          <div className="ds-navlist__genres">
            {genreSet.slice(0, 8).map((g) => (
              <span
                key={g}
                className="ds-navlist__genre-tag"
                onClick={() => {
                  setSection('library')
                  navigate('/')
                  onFilterChange?.('genre', g)
                }}
              >
                {g}
              <span className="ds-navlist__badge">{genreCounts[g] || 0}</span>
            </span>
          ))}
            {genreSet.length === 0 && <span className="text-tertiary" style={{ fontSize: 10 }}>{t('nav.emptyGenres')}</span>}
          </div>
        </div>

        <div className="ds-navlist__group">
          <div className="ds-navlist__group-title">{t('nav.tags')}</div>
          <div className="ds-navlist__genres">
            {tagList.slice(0, 8).map(([t, count]) => (
              <span
                key={t}
                className="ds-navlist__genre-tag"
                onClick={() => {
                  setSection('library')
                  navigate('/')
                  onFilterChange?.('tag', t)
                }}
              >
                {t}
                <span className="ds-navlist__badge">{count}</span>
              </span>
            ))}
            {tagList.length === 0 && <span className="text-tertiary" style={{ fontSize: 10 }}>{t('nav.emptyTags')}</span>}
          </div>
        </div>
      </nav>

      <div className="ds-sidebar__footer">
        <button className="ds-btn ds-btn--sm ds-btn--tertiary" style={{ gap: 4 }} onClick={handleMediaOpen}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span>{t('nav.media')}</span>
        </button>
        <button
          className="ds-btn ds-btn--sm ds-btn--icon ds-btn--tertiary"
          aria-label={t('nav.settings')}
          onClick={() => {
            setSection('settings')
            navigate('/settings')
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon">
            <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </aside>
  )
}