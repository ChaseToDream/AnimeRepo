import { useState } from 'react'
import { Routes, Route, Outlet, NavLink, useLocation } from 'react-router-dom'
import { AppProvider, useApp } from './store/AppContext'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import Library from './pages/Library'
import Detail from './pages/Detail'
import Player from './pages/Player'
import Stats from './pages/Stats'
import Settings from './pages/Settings'

// 带侧边栏的外壳布局（番剧库 / 统计 / 设置）
function ShellLayout({ onFilterChange, activeFilter }) {
  const { library, settings, scanning, scanProgress, t } = useApp()
  const location = useLocation()
  const totalEpisodes = library.reduce((n, a) => n + (a.episodes?.length || 0), 0)
  const isStats = location.pathname.startsWith('/stats')
  const isSettings = location.pathname.startsWith('/settings')
  // O4：扫描状态文案（收集 / 元数据阶段分别展示）
  const scanText = scanning
    ? scanProgress
      ? scanProgress.phase === 'metadata'
        ? t('status.metadata', { c: scanProgress.current, t: scanProgress.total })
        : t('status.found', { n: scanProgress.found })
      : t('status.scanning')
    : isSettings
      ? t('status.settings')
      : isStats
        ? t('status.stats')
        : t('status.library')

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
  const [filter, setFilter] = useState({ status: 'all', genre: '', query: '' })
  const handleFilterChange = (passedKey, passedValue) => {
    // Sidebar 回调：onFilterChange(filterKey, queryOrGenre)
    if (passedValue && passedKey === 'genre') {
      setFilter({ ...filter, genre: passedValue, status: 'all' })
    } else if (passedValue) {
      setFilter({ ...filter, query: passedValue })
    } else {
      setFilter({ ...filter, status: passedKey || 'all' })
    }
  }

  return (
    <AppProvider>
      <Routes>
        <Route path="/" element={<ShellLayout activeFilter={filter.status} onFilterChange={handleFilterChange} />}>
          <Route index element={<Library filter={filter} setFilter={setFilter} />} />
          <Route path="stats" element={<Stats />} />
          <Route path="settings" element={<Settings />} />
        </Route>
        <Route path="/anime/:id" element={<Detail />} />
        <Route path="/player/:animeId/:epId" element={<Player />} />
      </Routes>
    </AppProvider>
  )
}

export default App