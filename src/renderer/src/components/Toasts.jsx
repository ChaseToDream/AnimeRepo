// 轻量全局 Toast（U2）：展示操作结果反馈，点击可立即关闭
export default function Toasts({ toasts, dismiss }) {
  if (!toasts || !toasts.length) return null
  return (
    <div className="ds-toast-container">
      {toasts.map((t) => (
        <button
          key={t.id}
          className={'ds-toast ds-toast--' + (t.type || 'info')}
          onClick={() => dismiss(t.id)}
          aria-label="关闭提示"
        >
          {t.message}
        </button>
      ))}
    </div>
  )
}
