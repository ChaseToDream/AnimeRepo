// 通用对话框（B-03/UX-01）：替换原生 confirm / window.prompt ——
// 1) Electron 中 window.prompt 不受支持，调用静默返回 null（批量标签功能完全失效）；
// 2) 原生 confirm 在 frameless 无边框窗口下样式割裂，且与全局设计语言不统一。
// 组件复用 ds-components.css 的 ds-modal-backdrop / ds-dialog 设计系统样式。
import { useState, useEffect, useRef } from 'react'
import './Dialog.css'

// 确认对话框：open 受控；Esc 取消 / Enter 确认；danger 红色确认按钮
export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel?.()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onConfirm?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onConfirm, onCancel])

  if (!open) return null
  return (
    <div className="ds-modal-backdrop" onClick={onCancel}>
      <div className="ds-dialog" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="ds-dialog__head">
          <span className="ds-dialog__title">{title}</span>
        </div>
        <div className="ds-dialog__body">
          <p className="app-dialog__desc">{description}</p>
        </div>
        <div className="ds-dialog__foot">
          <button className="ds-btn ds-btn--secondary" onClick={onCancel}>{cancelText}</button>
          <button className={danger ? 'ds-btn app-dialog__confirm--danger' : 'ds-btn ds-btn--brand'} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

// 输入对话框：替代 window.prompt；支持建议项（点击追加到输入内容）
export function PromptDialog({
  open,
  title,
  label,
  placeholder = '',
  suggestions = [],
  confirmText = '确定',
  cancelText = '取消',
  onConfirm,
  onCancel
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef(null)

  // 打开时重置输入并聚焦
  useEffect(() => {
    if (open) {
      setValue('')
      const timer = setTimeout(() => inputRef.current?.focus(), 0)
      return () => clearTimeout(timer)
    }
  }, [open])

  const submit = () => onConfirm?.(value)

  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel?.()
    }
  }

  // 点击建议标签：追加到输入内容（逗号分隔，去重）
  const appendSuggestion = (tag) => {
    const parts = value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
    if (!parts.includes(tag)) parts.push(tag)
    setValue(parts.join(', '))
    inputRef.current?.focus()
  }

  if (!open) return null
  return (
    <div className="ds-modal-backdrop" onClick={onCancel}>
      <div className="ds-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="ds-dialog__head">
          <span className="ds-dialog__title">{title}</span>
        </div>
        <div className="ds-dialog__body">
          {label && <div className="app-dialog__label">{label}</div>}
          <div className="ds-input app-dialog__input">
            <input
              ref={inputRef}
              type="text"
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
          {suggestions.length > 0 && (
            <div className="app-dialog__suggestions">
              <span className="app-dialog__suggestions-label">已有标签（点击添加）</span>
              <div className="app-dialog__suggestions-list">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    className="ds-tag ds-tag--neutral-strong app-dialog__suggestion"
                    onClick={() => appendSuggestion(s)}
                    type="button"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="ds-dialog__foot">
          <button className="ds-btn ds-btn--secondary" onClick={onCancel}>{cancelText}</button>
          <button className="ds-btn ds-btn--brand" onClick={submit}>{confirmText}</button>
        </div>
      </div>
    </div>
  )
}
