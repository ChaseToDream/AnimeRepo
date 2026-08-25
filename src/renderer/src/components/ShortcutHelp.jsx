// 全局快捷键帮助面板（UX-2）：按 ? 或 F1 唤起，Esc 关闭。
// 挂在 AppRoutes 顶层，对图库/详情/播放页均生效（播放页自身的 Window keydown
// 处理器不消费状态键，二者互不冲突）。
import { useState, useEffect } from 'react'

const SHORTCUT_GROUPS = [
  {
    title: '全局',
    items: [
      ['? / F1', '打开 / 关闭本帮助面板'],
      ['Esc', '关闭弹窗 / 帮助面板']
    ]
  },
  {
    title: '播放页',
    items: [
      ['Space / K', '播放 / 暂停'],
      ['← / →', '快退 / 快进 5 秒'],
      ['↑ / ↓', '音量 + / -'],
      ['M', '静音'],
      ['F', '全屏'],
      ['P', '画中画'],
      ['Ctrl + 滚轮', '音量（在视频区）'],
      ['双击画面', '全屏']
    ]
  },
  {
    title: '媒体库',
    items: [
      ['单击卡片', '进入详情'],
      ['右键卡片', '快捷操作（播放 / 标记 / 收藏 / 删除）'],
      ['多选模式', '批量标记 / 收藏 / 标签 / 删除，完成后可「撤销」']
    ]
  }
]

export default function ShortcutHelp() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const tag = (e.target && e.target.tagName) || ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === '?' || e.code === 'F1') {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!open) return null

  return (
    <div className="ds-modal-backdrop" onClick={() => setOpen(false)}>
      <div
        className="ds-dialog"
        style={{ maxWidth: 520 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ds-dialog__head">
          <span className="ds-dialog__title">键盘快捷键</span>
          <button className="ds-dialog__close" aria-label="关闭" onClick={() => setOpen(false)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="ds-dialog__body">
          {SHORTCUT_GROUPS.map((g) => (
            <div key={g.title} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>{g.title}</div>
              {g.items.map(([key, desc]) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0', fontSize: 13 }}>
                  <span
                    style={{
                      minWidth: 120,
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: 'var(--bg-overlay-l2)',
                      color: 'var(--text-default)',
                      fontSize: 12,
                      textAlign: 'center',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {key}
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>{desc}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="ds-dialog__foot">
          <button className="ds-btn ds-btn--secondary" onClick={() => setOpen(false)}>关闭</button>
        </div>
      </div>
    </div>
  )
}