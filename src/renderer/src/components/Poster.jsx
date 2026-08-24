import { useState } from 'react'
import { coverGradient } from '../lib/format'

// 番剧封面组件（B11 修复）：网络图加载失败或缺失时自动降级为渐变占位，避免留白
// - anime: 番剧对象（读取 coverUrl / coverGradient / title）
// - as: 占位元素标签，默认 div（如 CSS 选择器限定 span 时传入 'span'）
// - imgClassName / bgClassName: 图片与占位元素各自的样式类
// - imgStyle / style: 分别作用于图片与占位元素的内联样式
// - children: 自定义占位内容（缺省显示番剧标题）
export default function Poster({
  anime,
  as: Tag = 'div',
  imgClassName = '',
  bgClassName = '',
  imgStyle,
  style,
  children
}) {
  const [failed, setFailed] = useState(false)
  const url = anime?.coverUrl
  const name = anime?.title ?? ''
  const bg = anime?.coverGradient || coverGradient(name)

  if (url && !failed) {
    return <img className={imgClassName} src={url} alt={name} onError={() => setFailed(true)} style={imgStyle} />
  }
  return (
    <Tag className={bgClassName} style={{ background: bg, ...style }}>
      {children ?? name}
    </Tag>
  )
}
