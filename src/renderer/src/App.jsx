import { Component, useState, useEffect } from 'react'
import { Routes, Route, Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { AppProvider, useApp, useScanProgress } from './store/AppContext'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import Library, { loadUiPrefs } from './pages/Library'
import Detail from './pages/Detail'
import Player from './pages/Player'
import Stats from './pages/Stats'
import History from './pages/History'
import Calendar from './pages/Calendar'
import Settings from './pages/Settings'

// P6：全局 Error Boundary——渲染期未捕获异常原先会卸载整棵 React 树，
// 窗口只剩白屏且无法恢复（本次白屏卡死的放大器）。兜底为可见的错误页 + 一键刷新。
class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            background: 'var(--bg-base, #0d0d12)',
            color: 'var(--text-1, #e8e8ea)',
            fontSize: 14
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 600 }}>界面出现了一个错误</div>
          <div style={{ opacity: 0.7, maxWidth: 520, textAlign: 'center', wordBreak: 'break-all' }}>
            {String(this.state.error?.message || this.state.error)}
          </div>
          <button
            className="ds-btn ds-btn--brand"
            onClick={() => window.location.reload()}
            style={{ marginTop: 8 }}
          >
            重新加载
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// P5：扫描进度文案叶子组件——整个应用唯一订阅 ScanProgressContext 的组件。
// 进度事件以 10Hz 高频推送，若由 ShellLayout 订阅，其子树（Sidebar/Library 等）
// 会跟着全树重渲染；下沉到叶子组件后每次进度更新只重渲染这一段文本。
function ScanStatusText() {
  const { t } = useApp()
  const scanProgress = useScanProgress()
  if (!scanProgress) return t('status.scanning')
  if (scanProgress.phase === 'metadata')
    return t('status.metadata', { c: scanProgress.current, t: scanProgress.total })
  return t('status.found', { n: scanProgress.found })
}

// 带侧边栏的外壳布局（番剧库 / 统计 / 历史 / 日历 / 设置）
function ShellLayout({ onFilterChange, activeFilter }) {
  const { library, settings, scanning, t, api } = useApp()
  const location = useLocation()
  const totalEpisodes = library.reduce((n, a) => n + (a.episodes?.length || 0), 0)
  const isStats = location.pathname.startsWith('/stats')
  const isSettings = location.pathname.startsWith('/settings')
  // O4：扫描状态文案（扫描中显示进度，否则显示当前页面名）
  const scanText = scanning ? (
    <ScanStatusText />
  ) : isSettings ? (
    t('status.settings')
  ) : isStats ? (
    t('status.stats')
  ) : (
    t('status.library')
  )

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="app-main-body">
        <Sidebar activeFilter={activeFilter} onFilterChange={onFilterChange} />
        <main className="app-content">
          <Outlet />
        </main>
      </div>
      <footer className="ds-statusbar">
        <div className="ds-statusbar__group">
          <span className="ds-statusbar__item">
            <span className="ds-statusbar__dot" style={{ background: scanning ? 'var(--status-warning-default)' : 'var(--status-success-default)' }} />
            {scanText}
            {/* UX-03：扫描中提供取消入口（已完成阶段的变更会保留） */}
            {scanning && (
              <button
                className="ds-btn ds-btn--sm ds-btn--tertiary"
                style={{ height: 18, marginLeft: 6, fontSize: 11 }}
                onClick={() => api?.cancelScan?.()}
              >
                取消
              </button>
            )}
          </span>
          {!isSettings && (
            <span
              className="ds-statusbar__item"
              // B3：反映真实开关，避免开关关闭时仍显示「已开启」
              style={{ color: settings?.autoScanOnStartup ? undefined : 'var(--status-warning-default)' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              {settings?.autoScanOnStartup ? t('status.autoSync') : t('status.autoSyncOff')}
            </span>
          )}
        </div>
        <div className="ds-statusbar__group">
          <span className="ds-statusbar__item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
            </svg>
            {t('status.count', { n: library.length, e: totalEpisodes })}
          </span>
        </div>
        <div className="ds-statusbar__group">
          {settings ? (
            <span className="ds-statusbar__item">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon">
                <path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
              </svg>
              {t('status.libraries', { n: settings.libraryFolders.length })}
            </span>
          ) : null}
          <span className="ds-statusbar__item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon">
              <circle cx="12" cy="12" r="9" />
            </svg>
          </span>
        </div>
      </footer>
    </div>
  )
}

function App() {
  const navigate = useNavigate()
  const { api } = useApp()

  // UX-08：订阅系统通知点击导航事件（新番通知直达详情页）。
  // 挂在 App 根组件而非 ShellLayout——用户停留在播放页（无外壳）时同样生效
  useEffect(() => {
    if (!api?.onNavigate) return undefined
    return api.onNavigate((path) => {
      if (path) navigate(path)
    })
  }, [api, navigate])

  // UX-04：状态筛选从上次会话恢复（仅初始化一次，避免覆盖运行中的筛选切换）
  const [filter, setFilter] = useState(() => {
    const prefs = loadUiPrefs()
    const valid = ['all', 'watching', 'completed', 'plan', 'onhold', 'recent']
    const status = valid.includes(prefs.status) ? prefs.status : 'all'
    return { status, genre: '', query: '', tag: '' }
  })
  const handleFilterChange = (passedKey, passedValue) => {
    // Sidebar 回调：onFilterChange(filterKey, queryOrGenre)
    if (passedValue && passedKey === 'genre') {
      setFilter({ ...filter, genre: passedValue, status: 'all' })
    } else if (passedValue && passedKey === 'tag') {
      setFilter({ ...filter, tag: passedValue, status: 'all' })
    } else if (passedValue) {
      setFilter({ ...filter, query: passedValue })
    } else {
      setFilter({ ...filter, status: passedKey || 'all' })
    }
  }

  return (
    <ErrorBoundary>
      <AppProvider>
        <Routes>
        <Route path="/" element={<ShellLayout activeFilter={filter.status} onFilterChange={handleFilterChange} />}>
          <Route index element={<Library filter={filter} setFilter={setFilter} />} />
          <Route path="stats" element={<Stats />} />
          <Route path="history" element={<History />} />
          <Route path="calendar" element={<Calendar />} />
          <Route path="settings" element={<Settings />} />
        </Route>
        <Route path="/anime/:id" element={<Detail />} />
        <Route path="/player/:animeId/:epId" element={<Player />} />
        </Routes>
      </AppProvider>
    </ErrorBoundary>
  )
}

export default App