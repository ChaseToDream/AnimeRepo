// 通用右键上下文菜单（UX-02）：Portal 到 body 渲染，避免被容器 overflow/transform 裁剪。
// 点击菜单项 / 点击空白 / Esc / 滚动 / 失焦 时自动关闭。
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import './ContextMenu.css'

export default function ContextMenu({ x, y, items, onClose }) {
  const menuRef = useRef(null)

  useEffect(() => {
    if (x == null || y == null) return undefined
    const handlePointer = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose?.()
    }
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    // pointerdown 捕获阶段：先于其他点击逻辑关闭菜单
    window.addEventListener('pointerdown', handlePointer, true)
    window.addEventListener('keydown', handleKey)
    window.addEventListener('wheel', onClose, { passive: true })
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', handlePointer, true)
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [x, y, onClose])

  if (x == null || y == null || !items?.length) return null

  // 视口边缘自适应：向右/下溢出时反向展开
  const style = { left: x, top: y }
  const estimateH = items.length * 30 + 8
  if (x + 180 > window.innerWidth) style.left = Math.max(4, window.innerWidth - 184)
  if (y + estimateH > window.innerHeight) style.top = Math.max(4, window.innerHeight - estimateH - 4)

  return createPortal(
    <div className="app-contextmenu" ref={menuRef} style={style} role="menu">
      {items.map((item, i) =>
        item.separator ? (
          <div className="app-contextmenu__separator" key={`sep-${i}`} />
        ) : (
          <button
            key={item.label}
            className={'app-contextmenu__item' + (item.danger ? ' is-danger' : '')}
            role="menuitem"
            onClick={() => {
              onClose?.()
              item.onClick?.()
            }}
          >
            {item.label}
          </button>
        )
      )}
    </div>,
    document.body
  )
}
