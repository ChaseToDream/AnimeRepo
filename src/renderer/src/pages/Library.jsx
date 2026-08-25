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
import { ConfirmDialog, PromptDialog } from '../components/Dialog'
import ContextMenu from '../components/ContextMenu'
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

// PF-01：列表虚拟滚动常量（.anime-list__row 固定 64px 高）
const LIST_ROW_H = 64
const LIST_OVERSCAN = 5

// UX-04：视图 / 排序 / 状态筛选持久化 key
const UI_PREF_KEY = 'animerepo.library.ui'

// 读取持久化的 UI 偏好（App.jsx 初始化筛选状态也复用此函数）
export function loadUiPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(UI_PREF_KEY) || '{}')
    return {
      view: raw.view === 'list' ? 'list' : 'grid',
      sort: typeof raw.sort === 'string' ? raw.sort : 'created',
      status: typeof raw.status === 'string' ? raw.status : 'all'
    }
  } catch (e) {
    return { view: 'grid', sort: 'created', status: 'all' }
  }
}

function PlayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon">
      <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none" />
    </svg>
  )
}

export default function Library({ filter, setFilter }) {
  const { library, scan, scanning, batchAnime, undoLastBatch, showToast, addFolder, settings, updateAnime, api, loading, createAnime, refreshMetaBatch } = useApp()
  const navigate = useNavigate()
  // UX-04：视图/排序从上次会话恢复（默认网格 + 添加时间）
  const [uiPrefs] = useState(loadUiPrefs)
  const [view, setView] = useState(uiPrefs.view)
  const [sort, setSort] = useState(uiPrefs.sort)
  // N4：多选模式与已选集
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  // B-03：应用内对话框状态（替换原生 confirm / 不受支持的 window.prompt）
  const [tagsDialogOpen, setTagsDialogOpen] = useState(false)
  // F-7：手动添加“想看”占位条目的输入对话框
  const [addOpen, setAddOpen] = useState(false)
  // O-10：批量补全元数据执行中
  const [refreshingMeta, setRefreshingMeta] = useState(false)
  // 删除确认目标（批量 = 选中集合；单个 = 右键菜单目标）
  const [removeTarget, setRemoveTarget] = useState(null)
  // UX-02：右键菜单状态 { x, y, anime }
  const [menu, setMenu] = useState(null)

  // UX-04：视图/排序/状态筛选变化时持久化。
  // 注意：状态筛选的「恢复」在 App.jsx 初始化时完成——若在 Library 挂载时恢复，
  // 用户在其他页面（Library 已卸载）通过侧栏切换筛选后返回，会被旧的持久化值覆盖
  useEffect(() => {
    try {
      localStorage.setItem(UI_PREF_KEY, JSON.stringify({ view, sort, status: filter.status || 'all' }))
    } catch (e) {
      /* localStorage 不可用时忽略 */
    }
  }, [view, sort, filter.status])

  // P3：搜索词延迟更新，避免每次输入触发全库过滤重算
  const deferredQuery = useDeferredValue(filter.query || '')
  const q = deferredQuery.trim().toLowerCase()
  // P-2：排序同样用低优先级渲染——切换排序或库变化时，排序结果异步重算，
  // 避免在大型媒体库上同步阻塞主线程导致滚动卡顿。
  const deferredSort = useDeferredValue(sort)
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

  // U5：排序（最近观看按时间倒序，其余按所选维度；deferredSort 低优先级重算）
  const sortedItems = useMemo(() => {
    const arr = [...items]
    if (filter.status === 'recent') {
      arr.sort((a, b) => new Date(b.lastWatchedAt || 0) - new Date(a.lastWatchedAt || 0))
      return arr
    }
    switch (deferredSort) {
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
  }, [items, deferredSort, filter.status])

  // O-13：继续观看——最近有播放记录的「正在观看」条目（按 lastWatchedAt 倒序）
  const continueRows = useMemo(() => {
    return library
      .filter((a) => a.lastWatchedAt && a.status === 'watching')
      .sort((a, b) => new Date(b.lastWatchedAt || 0) - new Date(a.lastWatchedAt || 0))
      .slice(0, 6)
  }, [library])

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

  // —— PF-01 列表视图虚拟滚动：行高固定 64px，仅渲染可视窗口 + overscan ——
  const listWrapRef = useRef(null)
  const [listView, setListView] = useState({ height: 0, scrollTop: 0 })

  // P6：网格容器仅在「网格视图且有内容」时挂载（空库时显示引导页）。
  // 原先 effect 只依赖 [view]，空库启动时 ref 还是 null、观察器没挂上，
  // 扫描完成网格首次出现后无人测量宽度（width=0 → 列数/行高全错，虚拟滚动失效）。
  const gridMounted = view === 'grid' && library.length > 0 && items.length > 0

  useEffect(() => {
    if (!gridMounted) return
    const el = gridWrapRef.current
    if (!el) return
    const update = () => setGridView((s) => ({ ...s, width: el.clientWidth, height: el.clientHeight }))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [gridMounted])

  // PF-01：列表容器测量（与网格同理，仅在列表视图有内容时挂载）
  const listMounted = view === 'list' && library.length > 0 && items.length > 0
  useEffect(() => {
    if (!listMounted) return
    const el = listWrapRef.current
    if (!el) return
    const update = () => setListView((s) => ({ ...s, height: el.clientHeight }))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [listMounted])

  // PF-01：可视窗口行切片（前后各 overscan 行，缓解快速滚动白屏）
  const listRows = useMemo(() => {
    const total = sortedItems.length
    const start = Math.max(0, Math.floor(listView.scrollTop / LIST_ROW_H) - LIST_OVERSCAN)
    const end = Math.min(
      total,
      Math.ceil((listView.scrollTop + listView.height) / LIST_ROW_H) + LIST_OVERSCAN
    )
    const rows = []
    for (let i = start; i < end; i++) rows.push({ index: i, a: sortedItems[i] })
    return rows
  }, [listView, sortedItems])

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
    // B-09d：全部已看时 nextEpisode 为 null——回退播放第一集，避免点击无响应
    const ep = nextEpisode(a) || (a.episodes || [])[0]
    if (ep) navigate(`/player/${a.id}/${ep.id}`)
  }

  // U1：首次引导——添加媒体库后立即触发扫描
  const handleAddFolder = async () => {
    const folders = await addFolder()
    if (folders && folders.length) scan()
  }

  // O-10：批量补全元数据（自动选择缺封面/简介的条目）
  const handleMetaBatch = async () => {
    if (refreshingMeta) return
    setRefreshingMeta(true)
    try {
      const res = await refreshMetaBatch()
      if (!res || !res.total) {
        showToast('没有需要补全的条目（封面与简介均已就绪）', 'info')
      } else {
        showToast(`补全完成：更新 ${res.updated} 部${res.failed ? `，失败 ${res.failed} 部` : ''}`, res.failed ? 'warning' : 'success')
      }
    } catch (e) {
      showToast('批量补全失败', 'error')
    } finally {
      setRefreshingMeta(false)
    }
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
    // UX-3：可撤销的批量操作在提示上提供「撤销」入口，点击精确回滚
    const reversible = ['mark-watched', 'mark-unwatched', 'set-status', 'set-favorite', 'set-tags'].includes(action)
    showToast(
      `已对 ${count} 部番剧执行批量操作`,
      'success',
      3500,
      reversible ? { label: '撤销', onClick: () => undoLastBatch() } : null
    )
  }
  // B-03：批量删除改为对话框确认（原生 confirm 在 frameless 窗口下样式割裂）
  // removeTarget：待删除的 ID 集合（批量 = 选中集；单个 = 右键菜单目标）
  const handleBatchRemove = () => {
    if (!selected.size) return
    setRemoveTarget([...selected])
  }
  const confirmBatchRemove = async () => {
    const ids = removeTarget || []
    setRemoveTarget(null)
    if (!ids.length) return
    await batchAnime('remove', ids)
    setSelected(new Set())
    setSelectionMode(false)
    showToast(`已删除 ${ids.length} 部番剧`, 'success')
  }
  const removeCount = removeTarget ? removeTarget.length : 0

  // —— UX-02：右键上下文菜单 ——
  const openMenu = (e, a) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, anime: a })
  }
  const buildMenuItems = (a) => {
    const eps = a.episodes || []
    // 播放目标：断点续看 > 首个未看 > 第一集（全部已看时从头播放）
    const ep = nextEpisode(a) || eps[0]
    const items = []
    if (ep) {
      items.push({
        label: `播放 EP${ep.number ?? 1}`,
        onClick: () => navigate(`/player/${a.id}/${ep.id}`)
      })
    }
    items.push({ label: '查看详情', onClick: () => navigate(`/anime/${a.id}`) })
    items.push({ separator: true })
    items.push({
      label: '标记为已看',
      onClick: async () => {
        await batchAnime('mark-watched', [a.id])
        showToast(`已将「${a.title}」标记为已看`, 'success')
      }
    })
    items.push({
      label: '标记为未看',
      onClick: async () => {
        await batchAnime('mark-unwatched', [a.id])
        showToast(`已将「${a.title}」标记为未看`, 'info')
      }
    })
    items.push({
      label: a.isFavorite ? '取消收藏' : '收藏',
      onClick: () => updateAnime(a.id, { isFavorite: !a.isFavorite })
    })
    if (a.path) {
      items.push({ label: '打开所在文件夹', onClick: () => api?.openFolder?.(a.path) })
    }
    items.push({ separator: true })
    items.push({ label: '删除', danger: true, onClick: () => setRemoveTarget([a.id]) })
    return items
  }
  // B-03：批量标签改为应用内输入对话框（Electron 不支持 window.prompt，原实现静默失效）
  const handleBatchTags = () => {
    if (!selected.size) return
    setTagsDialogOpen(true)
  }
  const confirmBatchTags = async (text) => {
    setTagsDialogOpen(false)
    // O-9：去重后再写入，并提示合并了多少个重复标签
    const raw = (text || '')
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const tags = [...new Set(raw)]
    if (!tags.length) return
    if (tags.length !== raw.length) {
      showToast(`已合并 ${raw.length - tags.length} 个重复标签`, 'info')
    }
    await runBatch('set-tags', { tags })
  }
  // 已有标签集合（供标签输入对话框补全建议）
  const allTags = useMemo(
    () => [...new Set(library.flatMap((a) => a.tags || []))].sort((a, b) => a.localeCompare(b, 'zh')),
    [library]
  )

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

          {/* O-10：批量补全缺失的封面/简介 */}
          <button
            className="ds-btn ds-btn--secondary ds-btn--sm"
            onClick={handleMetaBatch}
            disabled={refreshingMeta}
            style={refreshingMeta ? { opacity: 0.6, cursor: 'default' } : undefined}
            title="为缺少封面或简介的番剧批量补全在线资料"
          >
            {refreshingMeta ? '补全中…' : '补全元数据'}
          </button>

          {/* F-7：手动添加“想看”占位条目 */}
          <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={() => setAddOpen(true)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="icon"><path d="M12 5v14M5 12h14" /></svg>
            添加想看
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
        {/* UX-06：首屏加载骨架——库数据从主进程加载期间显示 shimmer 占位，
            消除启动时短暂白屏/引导页闪烁（引导页仅在真正空库时出现） */}
        {loading && library.length === 0 ? (
          <div className="library-skeleton">
            {Array.from({ length: 12 }, (_, i) => (
              <div className="library-skeleton__card" key={i}>
                <div className="library-skeleton__poster" />
                <div className="library-skeleton__line" />
                <div className="library-skeleton__line library-skeleton__line--short" />
              </div>
            ))}
          </div>
        ) : library.length === 0 ? (
          <div className="library-empty library-empty--wizard">
            <div className="wizard-icon">
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div className="library-empty__title">欢迎使用 AnimeRepo 溯番</div>
            <div className="library-empty__desc">三步开始你的番剧库：</div>
            <div className="wizard-steps">
              {/* UX-4：步骤可点击直达——步骤 1 打开文件夹选择、步骤 2 立即扫描 */}
              <div
                className="wizard-step"
                style={{ cursor: 'pointer' }}
                title="点击添加媒体库文件夹"
                onClick={handleAddFolder}
              >
                <span className="wizard-step__num">1</span>添加媒体库文件夹（存放番剧视频的目录）
              </div>
              <div
                className="wizard-step"
                style={{ cursor: 'pointer' }}
                title="点击立即扫描媒体库"
                onClick={() => scan()}
              >
                <span className="wizard-step__num">2</span>自动扫描并识别番剧与剧集
              </div>
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

            {/* O-13：继续观看快捷卡 */}
            {continueRows.length > 0 && (
              <div className="library-continue" style={{ margin: '12px 0 4px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>继续观看</div>
                <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 4 }}>
                  {continueRows.map((a) => {
                    const ep = nextEpisode(a) || (a.episodes || [])[0]
                    return (
                      <button
                        key={a.id}
                        onClick={() => ep && navigate(`/player/${a.id}/${ep.id}`)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, width: 240,
                          padding: 8, borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                          background: 'var(--bg-overlay-l1, #14151a)', border: '1px solid var(--border-neutral-l1, #26272e)',
                          color: 'inherit'
                        }}
                        title={`${a.title} · 继续播放 EP${ep ? ep.number : ''}`}
                      >
                        <Poster anime={a} as="span" imgStyle={{ width: 44, height: 62, objectFit: 'cover', borderRadius: 6 }} style={{ width: 44, height: 62, borderRadius: 6, fontSize: 8, padding: 4, boxSizing: 'border-box' }} />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</span>
                          <span style={{ fontSize: 11, opacity: 0.7 }}>{a.lastWatchedEpisode ? '上次看到 EP' : ''}{ep ? `EP${ep.number}` : ''}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {view === 'grid' ? (
              <div
                className="anime-grid-v"
                ref={gridWrapRef}
                onScroll={(e) => {
                  // P6 白屏卡死修复：必须在事件分发期间同步读取 currentTarget——
                  // React 在事件分发结束后会把 synthetic event 的 currentTarget 置空，
                  // 而 setState 的 updater 函数延迟到渲染阶段才执行；
                  // 原先在 updater 内访问 e.currentTarget.scrollTop 会得到 null.scrollTop，
                  // 渲染阶段抛出 TypeError 且无 Error Boundary 兜底 → 整棵组件树被卸载 → 白屏卡死
                  const st = e.currentTarget.scrollTop
                  setGridView((s) => ({ ...s, scrollTop: st }))
                }}
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
                          onContextMenu={(e) => openMenu(e, a)}
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
              <div
                className="anime-list-wrap"
                ref={listWrapRef}
                onScroll={(e) => {
                  // P6 白屏卡死修复同款：必须在事件分发期间同步读取 currentTarget
                  const st = e.currentTarget.scrollTop
                  setListView((s) => ({ ...s, scrollTop: st }))
                }}
              >
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
                  {/* PF-01：列表虚拟滚动——仅渲染可视窗口行，DOM 节点数与库规模解耦 */}
                  <div style={{ position: 'relative', height: sortedItems.length * LIST_ROW_H }}>
                    {listRows.map(({ index, a }) => (
                      <div
                        className={'anime-list__row' + (selected.has(a.id) ? ' is-selected' : '')}
                        key={a.id}
                        style={{ position: 'absolute', top: index * LIST_ROW_H, left: 0, right: 0 }}
                        onClick={() => (selectionMode ? toggleSelect(a.id) : navigate(`/anime/${a.id}`))}
                        onContextMenu={(e) => openMenu(e, a)}
                      >
                        <span className="anime-list__index">{index + 1}</span>
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
              </div>
            )}
          </>
        )}
      </div>

      {/* B-03：删除确认 / 批量标签输入（应用内对话框） */}
      <ConfirmDialog
        open={Boolean(removeTarget)}
        title="删除番剧"
        description={`确定删除选中的 ${removeCount} 部番剧吗？此操作不可恢复。`}
        confirmText="删除"
        danger
        onConfirm={confirmBatchRemove}
        onCancel={() => setRemoveTarget(null)}
      />
      <PromptDialog
        open={tagsDialogOpen}
        title="批量设置标签"
        label="输入标签（用逗号分隔）"
        placeholder="例如：神作, 治愈"
        suggestions={allTags.slice(0, 30)}
        onConfirm={confirmBatchTags}
        onCancel={() => setTagsDialogOpen(false)}
      />
      {/* F-7：手动添加“想看”占位条目 */}
      <PromptDialog
        open={addOpen}
        title="添加想看"
        label="输入番剧标题"
        placeholder="例如：进击的巨人 最终季"
        onConfirm={async (text) => {
          setAddOpen(false)
          const title = (text || '').trim()
          if (!title) return
          const res = await createAnime(title)
          if (res && res.exists) {
            showToast('库中已存在同名番剧，未重复添加', 'warning')
          } else if (res && res.ok) {
            showToast(`已添加「${res.anime.title}」到想看`, 'success')
          } else {
            showToast('添加失败', 'error')
          }
        }}
        onCancel={() => setAddOpen(false)}
      />

      {/* UX-02：右键上下文菜单 */}
      <ContextMenu
        x={menu?.x}
        y={menu?.y}
        items={menu ? buildMenuItems(menu.anime) : []}
        onClose={() => setMenu(null)}
      />
    </div>
  )
}