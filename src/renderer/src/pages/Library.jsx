import { useState, useMemo, useRef, useEffect, useDeferredValue } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../store/AppContext'
import {
  STATUS_LABEL,
  STATUS_TAG_CLASS,
  formatHours,
  formatRating,
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

// U5：排序选项
const SORT_OPTIONS = [
  { key: 'created', label: '添加时间' },
  { key: 'title', label: '标题' },
  { key: 'rating', label: '评分' },
  { key: 'progress', label: '进度' }
]

// P4-4：网格虚拟滚动常量（与 .anime-grid 的 gap/padding 对应）
// GRID_GAP 随界面密度变化，见组件内 gridGap 计算
const GRID_TOP_PAD = 24    // 顶部/底部留白（与原 grid 上下 padding 一致）
const GRID_PAD_X = 48      // 左右留白（.anime-grid-v padding 24px * 2）
const MIN_CARD_W = 160

function PlayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon">
      <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none" />
    </svg>
  )
}

export default function Library({ filter, setFilter }) {
  const { library, scan, scanning, batchAnime, showToast, addFolder, settings } = useApp()
  const navigate = useNavigate()
  const [view, setView] = useState('grid')
  const [sort, setSort] = useState('created')
  // N4：多选模式与已选集
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState(() => new Set())

  // P3：搜索词延迟更新，避免每次输入触发全库过滤重算
  const deferredQuery = useDeferredValue(filter.query || '')
  const q = deferredQuery.trim().toLowerCase()
  const items = useMemo(() => {
    return library.filter((a) => {
      // U5：最近观看筛选（存在 lastWatchedAt 记录）
      if (filter.status === 'recent') {
        if (!a.lastWatchedAt) return false
      } else if (filter.status && filter.status !== 'all' && a.status !== filter.status) {
        return false
      }
      if (filter.genre && !(a.genres || []).includes(filter.genre)) return false
      if (filter.tag && !(a.tags || []).includes(filter.tag)) return false
      if (q) {
        const title = (a.title || '').toLowerCase()
        const desc = (a.description || '').toLowerCase()
        if (!title.includes(q) && !desc.includes(q)) return false
      }
      return true
    })
  }, [library, filter.status, filter.genre, filter.tag, q])

  // U5：排序（最近观看按时间倒序，其余按所选维度）
  const sortedItems = useMemo(() => {
    const arr = [...items]
    if (filter.status === 'recent') {
      arr.sort((a, b) => new Date(b.lastWatchedAt || 0) - new Date(a.lastWatchedAt || 0))
      return arr
    }
    switch (sort) {
      case 'title':
        arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh'))
        break
      case 'rating':
        arr.sort((a, b) => (b.rating || 0) - (a.rating || 0))
        break
      case 'progress':
        arr.sort((a, b) => progressPct(b) - progressPct(a))
        break
      default:
        arr.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    }
    return arr
  }, [items, sort, filter.status])

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
    filter.status === 'recent'
      ? '最近观看'
      : filter.status && filter.status !== 'all'
        ? STATUS_LABEL[filter.status] || '全部番剧'
        : '全部番剧'

  // —— P4-4 网格虚拟滚动：仅渲染可视区域的行，DOM 节点数从数千降到 ~几十 ——
  const gridWrapRef = useRef(null)
  const [gridView, setGridView] = useState({ width: 0, height: 0, scrollTop: 0 })

  useEffect(() => {
    if (view !== 'grid') return
    const el = gridWrapRef.current
    if (!el) return
    const update = () => setGridView((s) => ({ ...s, width: el.clientWidth, height: el.clientHeight }))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [view])

  // P4-4：网格行间距与 CSS --spacer-16 保持一致，随界面密度同步（保证虚拟滚动行定位不漂移）
  const gridGap = settings?.uiDensity === '紧凑' ? 13 : settings?.uiDensity === '宽松' ? 19 : 16

  const grid = useMemo(() => {
    const w = gridView.width
    const cols = w > 0 ? Math.max(1, Math.floor((w - GRID_PAD_X + gridGap) / (MIN_CARD_W + gridGap))) : 5
    const cardW = cols > 0 ? (w - GRID_PAD_X - (cols - 1) * gridGap) / cols : MIN_CARD_W
    const rowH = cardW * 1.5 + 2
    const rowCount = Math.ceil(sortedItems.length / cols)
    const totalH = rowCount > 0 ? rowCount * rowH + (rowCount - 1) * gridGap + GRID_TOP_PAD * 2 : 0
    // 可视行范围（前后各 overscan 2 行，缓解滚动跳动）
    const startRow = Math.max(0, Math.floor((gridView.scrollTop - GRID_TOP_PAD) / (rowH + gridGap)) - 2)
    const endRow = Math.min(rowCount, Math.ceil((gridView.scrollTop + gridView.height - GRID_TOP_PAD) / (rowH + gridGap)) + 2)
    const rows = []
    for (let r = startRow; r < endRow; r++) {
      rows.push({ r, items: sortedItems.slice(r * cols, r * cols + cols) })
    }
    return { cols, cardW, rowH, rowCount, totalH, rows }
  }, [gridView, sortedItems, gridGap])

  const handlePlay = (e, a) => {
    e.stopPropagation()
    const ep = nextEpisode(a)
    if (ep) navigate(`/player/${a.id}/${ep.id}`)
  }

  // U1：首次引导——添加媒体库后立即触发扫描
  const handleAddFolder = async () => {
    const folders = await addFolder()
    if (folders && folders.length) scan()
  }

  // —— N4 多选与批量操作 ——
  const enterSelection = () => {
    setSelected(new Set())
    setSelectionMode(true)
  }
  const exitSelection = () => {
    setSelected(new Set())
    setSelectionMode(false)
  }
  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const allSelected = sortedItems.length > 0 && sortedItems.every((a) => selected.has(a.id))
  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(sortedItems.map((a) => a.id)))
  }
  const runBatch = async (action, payload) => {
    if (!selected.size) return
    const count = selected.size
    await batchAnime(action, [...selected], payload)
    setSelected(new Set())
    showToast(`已对 ${count} 部番剧执行批量操作`, 'success')
  }
  const handleBatchRemove = async () => {
    if (!selected.size) return
    if (confirm(`确定删除选中的 ${selected.size} 部番剧吗？此操作不可恢复。`)) {
      await runBatch('remove')
      setSelectionMode(false)
    }
  }
  const handleBatchTags = () => {
    if (!selected.size) return
    const tags = (window.prompt('输入标签（用逗号分隔）') || '')
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (tags.length) runBatch('set-tags', { tags })
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

          <select className="ds-select library-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="排序方式">
            {SORT_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>

          <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={selectionMode ? exitSelection : enterSelection}>
            {selectionMode ? '取消选择' : '多选'}
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
          <div className="library-empty library-empty--wizard">
            <div className="wizard-icon">
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div className="library-empty__title">欢迎使用 AnimeRepo 溯番</div>
            <div className="library-empty__desc">三步开始你的番剧库：</div>
            <div className="wizard-steps">
              <div className="wizard-step"><span className="wizard-step__num">1</span>添加媒体库文件夹（存放番剧视频的目录）</div>
              <div className="wizard-step"><span className="wizard-step__num">2</span>自动扫描并识别番剧与剧集</div>
              <div className="wizard-step"><span className="wizard-step__num">3</span>开始观看并记录进度</div>
            </div>
            <div className="library-empty__actions">
              <button className="ds-btn ds-btn--brand" onClick={handleAddFolder}>
                添加媒体库文件夹
              </button>
              <button className="ds-btn ds-btn--secondary" onClick={() => navigate('/settings')}>
                前往设置
              </button>
            </div>
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
            {selectionMode && (
              <div className="library-batchbar">
                <button className="ds-btn ds-btn--sm ds-btn--secondary" onClick={toggleSelectAll}>
                  {allSelected ? '取消全选' : '全选'}
                </button>
                <span className="library-batchbar__count">已选 {selected.size} 部</span>
                <button className="ds-btn ds-btn--sm ds-btn--secondary" onClick={() => runBatch('mark-watched')}>标记已看</button>
                <button className="ds-btn ds-btn--sm ds-btn--secondary" onClick={() => runBatch('mark-unwatched')}>标记未看</button>
                <select
                  className="ds-select"
                  defaultValue=""
                  onChange={(e) => { if (e.target.value) runBatch('set-status', { status: e.target.value }) }}
                  aria-label="批量设置状态"
                >
                  <option value="" disabled>设为状态…</option>
                  <option value="watching">正在观看</option>
                  <option value="completed">已完成</option>
                  <option value="plan">想看</option>
                  <option value="onhold">搁置</option>
                </select>
                <button className="ds-btn ds-btn--sm ds-btn--secondary" onClick={() => runBatch('set-favorite', { favorite: true })}>收藏</button>
                <button className="ds-btn ds-btn--sm ds-btn--secondary" onClick={() => runBatch('set-favorite', { favorite: false })}>取消收藏</button>
                <button className="ds-btn ds-btn--sm ds-btn--secondary" onClick={handleBatchTags}>标签…</button>
                <button className="ds-btn ds-btn--sm library-batchbar__danger" onClick={handleBatchRemove}>删除</button>
                <button className="ds-btn ds-btn--sm ds-btn--tertiary" onClick={exitSelection}>退出</button>
              </div>
            )}

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
              <div
                className="anime-grid-v"
                ref={gridWrapRef}
                onScroll={(e) => setGridView((s) => ({ ...s, scrollTop: e.currentTarget.scrollTop }))}
              >
                <div className="anime-grid-v__canvas" style={{ height: grid.totalH }}>
                  {grid.rows.map(({ r, items }) => (
                    <div
                      key={r}
                      className="anime-grid-v__row"
                      style={{
                        transform: `translateY(${GRID_TOP_PAD + r * (grid.rowH + gridGap)}px)`,
                        gridTemplateColumns: `repeat(${grid.cols}, ${grid.cardW}px)`
                      }}
                    >
                      {items.map((a) => (
                        <article
                          className={'anime-card' + (selected.has(a.id) ? ' is-selected' : '')}
                          key={a.id}
                          onClick={() => (selectionMode ? toggleSelect(a.id) : navigate(`/anime/${a.id}`))}
                        >
                          {selectionMode && (
                            <div className={'anime-card__select' + (selected.has(a.id) ? ' is-on' : '')}>
                              {selected.has(a.id) ? (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                              ) : null}
                            </div>
                          )}
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
                                  {formatRating(a.rating, settings?.ratingSystem)}
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
                  ))}
                </div>
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
                  {sortedItems.map((a, i) => (
                    <div
                      className={'anime-list__row' + (selected.has(a.id) ? ' is-selected' : '')}
                      key={a.id}
                      onClick={() => (selectionMode ? toggleSelect(a.id) : navigate(`/anime/${a.id}`))}
                    >
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
                        {formatRating(a.rating, settings?.ratingSystem)}
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