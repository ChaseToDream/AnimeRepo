// 轻量全局 Toast（U2）：展示操作结果反馈，点击消息可关闭；
// 支持可选 action（如「撤销」），action 为 { label, onClick }
export default function Toasts({ toasts, dismiss }) {
  if (!toasts || !toasts.length) return null
  return (
    <div className="ds-toast-container">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={'ds-toast ds-toast--' + (t.type || 'info')}
          aria-label="提示"
          style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'default' }}
        >
          <span
            className="ds-toast__msg"
            style={{ cursor: 'pointer' }}
            onClick={() => dismiss(t.id)}
          >
            {t.message}
          </span>
          {t.action && (
            <button
              type="button"
              className="ds-toast__action"
              style={{ flexShrink: 0, cursor: 'pointer', color: 'var(--accent-color, #32F08C)', fontWeight: 600 }}
              onClick={() => { dismiss(t.id); t.action.onClick() }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
