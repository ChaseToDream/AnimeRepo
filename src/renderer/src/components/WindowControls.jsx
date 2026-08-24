import api from '../lib/api'

// Windows 风格窗口控制按钮（最小化/最大化/关闭）
export default function WindowControls() {
  return (
    <div className="ds-wbtitlebar__wincontrols">
      <button className="ds-wbtitlebar__winbtn" aria-label="最小化" onClick={() => api.minimize()}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <line x1="2" y1="6" x2="10" y2="6" />
        </svg>
      </button>
      <button className="ds-wbtitlebar__winbtn" aria-label="最大化" onClick={() => api.maximize()}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <rect x="2.5" y="2.5" width="7" height="7" rx="0.5" />
        </svg>
      </button>
      <button className="ds-wbtitlebar__winbtn ds-wbtitlebar__winbtn--close" aria-label="关闭" onClick={() => api.close()}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <line x1="3" y1="3" x2="9" y2="9" />
          <line x1="9" y1="3" x2="3" y2="9" />
        </svg>
      </button>
    </div>
  )
}