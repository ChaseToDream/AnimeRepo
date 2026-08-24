import WindowControls from './WindowControls'

// 通用标题栏：支持左侧 icon/title/可选返回，右侧通知与窗口控制
export default function TitleBar({ title = 'AnimeRepo · 溯番', back, onBack, children }) {
  return (
    <header className="ds-wbtitlebar">
      <div className="ds-wbtitlebar__left">
        <div className="ds-wbtitlebar__app-icon" style={{ background: 'var(--accent-color)' }}>溯</div>
        <span className="ds-wbtitlebar__title">{title}</span>
        <span className="ds-wbtitlebar__mode-chip">PRO</span>
      </div>
      <div className="ds-wbtitlebar__right">
        <button className="ds-wbtitlebar__iconbtn" aria-label="通知">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
        </button>
        <WindowControls />
      </div>
    </header>
  )
}