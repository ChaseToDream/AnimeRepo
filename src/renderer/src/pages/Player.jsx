import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApp } from '../store/AppContext'
import WindowControls from '../components/WindowControls'
import { formatTime, coverGradient } from '../lib/format'
import api from '../lib/api'
import './Player.css'

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]
const QUALITIES = ['480P', '720P', '1080P']
const SETTING_TABS = ['视频', '音频', '字幕', '播放']
const PROGRESS_SAVE_INTERVAL = 5000

// 字幕大小 → cue 字号（兼容设置页英文值与历史中文值）
const SUB_SIZE_MAP = {
  small: '0.9em', medium: '1.15em', large: '1.4em', xlarge: '1.7em',
  小: '0.9em', 中: '1.15em', 大: '1.4em', 特大: '1.7em'
}

// h:mm:ss.cc → HH:MM:SS.mmm（VTT 时间格式）
function normVttTime(t) {
  const parts = String(t).split(':')
  const h = parts.length === 3 ? parts[0].padStart(2, '0') : '00'
  const m = (parts.length === 3 ? parts[1] : parts[0]).padStart(2, '0')
  const rest = parts.length === 3 ? parts[2] : parts[1]
  const [s, ms] = String(rest).split('.')
  const ss = (s || '0').padStart(2, '0')
  // ASS 使用厘秒（.50 = 500ms），故毫秒部分向后补零
  const mmm = (ms || '0').padEnd(3, '0').slice(0, 3)
  return `${h}:${m}:${ss}.${mmm}`
}

// 简易 ASS/SSA → VTT：提取 Dialogue 对话文本，忽略样式/定位/特效
function assToVtt(text) {
  const lines = text.split(/\r?\n/)
  const out = ['WEBVTT']
  let inEvents = false
  for (const line of lines) {
    if (/^\[Events\]/i.test(line)) { inEvents = true; continue }
    if (inEvents && /^\[/.test(line)) inEvents = false
    if (!inEvents) continue
    const m = line.match(/^Dialogue:\s*[^,]*,\s*([\d:.]+),\s*([\d:.]+),\s*[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,(.*)$/)
    if (!m) continue
    const body = m[3].replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n').trim()
    if (!body) continue
    out.push('', `${normVttTime(m[1])} --> ${normVttTime(m[2])}`, body)
  }
  return out.join('\n')
}

// SRT / ASS / VTT → WebVTT 文本（供 <track> 使用）
function toVtt(text) {
  if (!text) return ''
  const clean = String(text).replace(/^\uFEFF/, '')
  if (/^WEBVTT/.test(clean)) return clean
  if (/^Dialogue:|^\[Events\]/m.test(clean)) return assToVtt(clean)
  return 'WEBVTT\n\n' + clean
    .replace(/\r\n/g, '\n')
    .replace(/(\d{1,2}):(\d{2}):(\d{2}),(\d{1,3})/g, '$1:$2:$3.$4')
}

// 本地视频调节：共享一个 CSS filter 应用于 <video>
function VideoFilter({ brightness, contrast, saturation, hue }) {
  return `brightness(${brightness / 50}) contrast(${contrast / 50}) saturate(${saturation / 50}) hue-rotate(${hue * 3.6}deg)`
}

// 开关（ds-switch 可变体）
function Switch({ on, onChange, label, disabled }) {
  return (
    <button
      className={`setting-switch${on ? ' is-on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
      onClick={() => !disabled && onChange(!on)}
    >
      <span className="setting-switch__thumb" />
    </button>
  )
}

export default function Player() {
  const { animeId, epId } = useParams()
  const navigate = useNavigate()
  const { library, getAnime, setProgress, setProgressSilent, updateSettings, updateAnime, settings } = useApp()

  const anime = getAnime(animeId)
  const ep = anime?.episodes?.find((e) => e.id === epId)

  const videoRef = useRef(null)
  const lastSaveRef = useRef(0)
  const progressRef = useRef({ time: 0, dur: 0 })

  // —— 播放状态 ——
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(settings?.defaultVolume ?? 80)
  const [speed, setSpeed] = useState(settings?.defaultPlaySpeed ?? 1.0)
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false)

  // —— 侧栏 & 设置面板 UI ——
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarTab, setSidebarTab] = useState('episodes')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState('视频')

  // —— 图像（本地 state 映射到 video filter，不持久化） ——
  const [brightness, setBrightness] = useState(50)
  const [contrast, setContrast] = useState(50)
  const [saturation, setSaturation] = useState(50)
  const [hue, setHue] = useState(0)

  // —— 画质 / 音频 / 字幕 / 播放 偏好 ——
  const [quality, setQuality] = useState(settings?.quality || '1080P')
  const [hardwareAccel, setHardwareAccel] = useState(settings?.hardwareDecode ?? true)
  const [autoNext, setAutoNext] = useState(settings?.autoNextEpisode ?? true)
  const [skipOpEd, setSkipOpEd] = useState(settings?.skipOpEd ?? true)
  const [subSize, setSubSize] = useState(settings?.subtitleFontSize || 'medium')
  const [audioGain, setAudioGain] = useState(100)
  const [audioDelay, setAudioDelay] = useState(0)

  // —— 字幕 ——
  const [subtitleText, setSubtitleText] = useState('')
  const [vttUrl, setVttUrl] = useState('')
  // N1：多字幕轨选择
  const [subtitleIndex, setSubtitleIndex] = useState(0)

  // —— 播放错误态 ——
  const [playError, setPlayError] = useState('')

  // 同番剧剧集（按 number 排序）
  const episodes = (anime?.episodes || [])
    .slice()
    .sort((a, b) => a.number - b.number)
  const epIndex = episodes.findIndex((e) => e.id === epId)
  const prevEp = epIndex > 0 ? episodes[epIndex - 1] : null
  const nextEp = epIndex >= 0 && epIndex < episodes.length - 1 ? episodes[epIndex + 1] : null

  const videoSrc = ep?.filePath ? window.api?.toVideoUrl?.(ep.filePath) || '' : ''

  // 收藏（基于 anime.isFavorite 派生，随媒体库更新自动刷新）
  const fav = !!anime?.isFavorite
  const toggleFavorite = (e) => {
    e?.stopPropagation?.()
    updateAnime(animeId, { isFavorite: !fav })
  }

  // —— 控制逻辑 ——
  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) v.play().catch(() => {})
    else v.pause()
  }, [])

  const seekTo = useCallback(
    (val) => {
      const v = videoRef.current
      if (!v || !duration) return
      const t = Math.max(0, Math.min(duration, val))
      v.currentTime = t
      setCurrentTime(t)
      progressRef.current.time = t
    },
    [duration]
  )

  const setSpeedRate = useCallback((s) => {
    setSpeed(s)
    setSpeedMenuOpen(false)
    if (videoRef.current) videoRef.current.playbackRate = s
  }, [])

  const setVol = useCallback((val) => {
    setVolume(val)
    if (videoRef.current) videoRef.current.volume = val / 100
  }, [])

  const goEp = useCallback((id) => {
    if (!id) return
    navigate(`/player/${animeId}/${id}`)
  }, [animeId, navigate])

  // 保存进度（防抖：接收是否立即保存）
  const flushProgress = useCallback(() => {
    const { time, dur } = progressRef.current
    if (time > 0) setProgress(animeId, epId, time, dur || 0)
  }, [animeId, epId, setProgress])

  // —— 视频事件 ——
  const handleLoadedMetadata = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    setDuration(v.duration || 0)
    v.playbackRate = speed
    v.volume = volume / 100
    const p = ep?.progress || 0
    if (p > 0 && p < (v.duration || 0) - 2) {
      v.currentTime = p
      setCurrentTime(p)
      progressRef.current.time = p
    }
    // 自动播放：失败时降级为静音播放
    const tryPlay = (muted) => {
      if (!v) return
      v.muted = muted
      v.play().catch(() => {
        if (!muted) tryPlay(true)
      })
    }
    tryPlay(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epId])

  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    setCurrentTime(v.currentTime)
    progressRef.current.time = v.currentTime
    progressRef.current.dur = v.duration
    const now = Date.now()
    if (now - lastSaveRef.current >= PROGRESS_SAVE_INTERVAL) {
      lastSaveRef.current = now
      // P4-5：播放中静默保存，不触发全局重渲染；退出/切集时由 flushProgress 同步一次
      setProgressSilent(animeId, epId, v.currentTime, v.duration || 0)
    }
  }, [animeId, epId, setProgressSilent])

  // 切换剧集 / 卸载时保存一次
  useEffect(() => {
    lastSaveRef.current = 0
    progressRef.current = { time: 0, dur: 0 }
    setPlayError('')
    setSubtitleIndex(0)
    return () => {
      flushProgress()
    }
  }, [epId, flushProgress])

  // beforeunload 保存
  useEffect(() => {
    const onUnload = () => flushProgress()
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [flushProgress])

  // 全屏 / 画中画
  const fullscreen = () => {
    const v = videoRef.current
    if (!v) return
    try {
      if (document.fullscreenElement) document.exitFullscreen()
      else v.requestFullscreen()
    } catch (e) {
      /* ignore */
    }
  }
  const pip = () => {
    const v = videoRef.current
    if (!v) return
    try {
      if (document.pictureInPictureElement) document.exitPictureInPicture()
      else if (window.documentPictureInPicture) {
        window.documentPictureInPicture.requestWindow({ width: 480, height: 270 })
      } else if (v.requestPictureInPicture) {
        v.requestPictureInPicture()
      }
    } catch (e) {
      /* ignore */
    }
  }

  // 设置项持久化
  const persist = (patch) => {
    if (settings) updateSettings(patch)
  }

  // —— 字幕 ——
  // 当前剧集可用字幕轨（N1：支持多字幕选择；兼容旧 subtitlePath 数据）
  const subtitleList = useMemo(() => {
    const paths = ep?.subtitlePaths || []
    if (paths.length) return paths
    return ep?.subtitlePath ? [ep.subtitlePath] : []
  }, [ep])

  // 加载当前选择的字幕轨内容
  useEffect(() => {
    let cancelled = false
    setSubtitleText('')
    const target = subtitleList[subtitleIndex]
    if (target) {
      api.readSubtitle(target)
        .then((text) => { if (!cancelled && text) setSubtitleText(text) })
        .catch(() => {})
    }
    return () => { cancelled = true }
  }, [epId, subtitleIndex, subtitleList])

  // 字幕文本 → WebVTT Blob URL（供 <track> 使用）
  useEffect(() => {
    setVttUrl('')
    if (!subtitleText) return
    const vtt = toVtt(subtitleText)
    if (!/-->/.test(vtt)) return
    const blob = new Blob([vtt], { type: 'text/vtt;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    setVttUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [subtitleText])

  // 字幕显示样式（字号 / 描边），通过动态 <style> 注入 ::cue
  useEffect(() => {
    const style = document.createElement('style')
    const stroke = settings?.subtitleStroke !== false
    style.textContent = `
      .player-video::cue {
        font-size: ${SUB_SIZE_MAP[subSize] || '1.15em'};
        background: rgba(0, 0, 0, 0.6);
        text-shadow: ${stroke ? '1px 1px 2px #000, 0 0 1px #000' : 'none'};
      }
    `
    document.head.appendChild(style)
    return () => { document.head.removeChild(style) }
  }, [subSize, settings?.subtitleStroke])

  // —— 播放错误态 ——
  // 视频加载/解码失败时给出可操作的错误提示
  const handleVideoError = useCallback(() => {
    setPlayError('视频文件不存在、已损坏或格式不受支持，无法播放')
  }, [])

  // —— 自动下一集 ——
  // 播放结束：标记当前集已看，按设置自动播放下一集
  const handleEnded = useCallback(() => {
    if (epId) setWatched(animeId, epId, true)
    if (autoNext && nextEp) goEp(nextEp.id)
  }, [animeId, epId, autoNext, nextEp, goEp, setWatched])

  // —— 键盘快捷键 ——
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const v = videoRef.current
      if (!v) return
      switch (e.code) {
        case 'Space':
        case 'KeyK':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowLeft':
          e.preventDefault()
          seekTo(v.currentTime - 5)
          break
        case 'ArrowRight':
          e.preventDefault()
          seekTo(v.currentTime + 5)
          break
        case 'ArrowUp':
          e.preventDefault()
          setVolume((prev) => {
            const next = Math.min(100, prev + 5)
            if (videoRef.current) videoRef.current.volume = next / 100
            return next
          })
          break
        case 'ArrowDown':
          e.preventDefault()
          setVolume((prev) => {
            const next = Math.max(0, prev - 5)
            if (videoRef.current) videoRef.current.volume = next / 100
            return next
          })
          break
        case 'KeyM':
          e.preventDefault()
          v.muted = !v.muted
          break
        case 'KeyF':
          e.preventDefault()
          fullscreen()
          break
        case 'KeyP':
          e.preventDefault()
          pip()
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, seekTo, fullscreen, pip])

  if (!anime || !ep) {
    return (
      <div className="player-page">
        <header className="ds-wbtitlebar player-notfound-titlebar">
          <div className="ds-wbtitlebar__left">
            <button className="titlebar-back" aria-label="返回" onClick={() => navigate(-1)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <span className="ds-wbtitlebar__title">未找到剧集</span>
          </div>
          <div className="ds-wbtitlebar__right"><WindowControls /></div>
        </header>
        <div className="player-empty">未找到该剧集</div>
      </div>
    )
  }

  const filter = VideoFilter({ brightness, contrast, saturation, hue })
  const title = `${anime.title} · 第 ${ep.number ?? ''} 话`
  const qualityPct = ((currentTime / (duration || 1)) * 100).toFixed(2)

  return (
    <div className="player-page">
      <div className="player-main">
        {/* ===== 视频区 ===== */}
        <div className="player-video-container" onClick={(e) => {
          // 点击空白处播放/暂停（避免点击控制元素误触发）
          if (e.target === e.currentTarget) togglePlay()
        }}>
          {/* 浮动标题栏 */}
          <header className="player-titlebar">
            <div className="player-titlebar__left">
              <button className="player-titlebar__back" aria-label="返回" onClick={() => navigate(-1)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <div className="player-titlebar__title-group">
                <div className="player-titlebar__title">{title}</div>
                <div className="player-titlebar__subtitle">第 {ep.number ?? '?'} 话 · {ep.title || '第 ' + ep.number + ' 话'}</div>
              </div>
            </div>
            <div className="player-titlebar__right">
              <WindowControls />
            </div>
          </header>

          {/* 视频 */}
          <video
            ref={videoRef}
            className="player-video"
            src={videoSrc}
            onClick={togglePlay}
            style={{ filter }}
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={handleTimeUpdate}
            onPlay={() => { setPlaying(true); setSpeedMenuOpen(false) }}
            onPause={() => setPlaying(false)}
            onEnded={handleEnded}
            onError={handleVideoError}
          >
            {vttUrl ? <track kind="subtitles" label="字幕" srcLang="zh" src={vttUrl} default /> : null}
          </video>

          {/* 视频加载错误覆盖层 */}
          {playError && (
            <div className="player-error">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <p className="player-error__text">{playError}</p>
              <button className="ds-btn ds-btn--brand" onClick={() => navigate(-1)}>返回详情</button>
            </div>
          )}

          {/* 左上角集数 */}
          <div className="player-video-corner player-video-corner--tl">
            <span className="player-ep-tag">EP {String(ep.number ?? 0).padStart(2, '0')}</span>
          </div>

          {/* 中央播放按钮 */}
          {!playing && (
            <button className="player-center-play" aria-label="播放" onClick={togglePlay}>
              <svg className="icon" width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            </button>
          )}

          {/* ===== 底部控制栏 ===== */}
          <div className="player-controls">
            {/* 进度条 */}
            <div className="player-progress">
              <input
                type="range"
                className="player-progress__range"
                min="0"
                max={duration || 0}
                step="0.1"
                value={currentTime}
                onChange={(e) => seekTo(Number(e.target.value))}
                aria-label="播放进度"
              />
              <div className="player-progress__played" style={{ width: `${qualityPct}%` }} />
            </div>

            {/* 时间显示 */}
            <div className="player-time">
              <span className="player-time__current">{formatTime(currentTime)}</span>
              <span className="player-time__duration">/ {formatTime(duration)}</span>
            </div>

            {/* 控制行 */}
            <div className="player-controls__row">
              <div className="player-controls__group">
                <button className="player-ctrl-btn" aria-label="上一集" disabled={!prevEp} onClick={() => goEp(prevEp?.id)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 5v14M20 6l-8 6 8 6V6z" transform="translate(2 0)" /></svg>
                </button>

                <button className="player-play-btn" aria-label={playing ? '暂停' : '播放'} onClick={togglePlay}>
                  {playing ? (
                    <svg className="icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                  ) : (
                    <svg className="icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                  )}
                </button>

                <button className="player-ctrl-btn" aria-label="下一集" disabled={!nextEp} onClick={() => goEp(nextEp?.id)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5v14M12 6l8 6-8 6V6z" transform="translate(0 0)"/></svg>
                </button>

                <div className="player-volume">
                  <span className="player-ctrl-btn player-volume__icon" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></svg>
                  </span>
                  <input
                    type="range"
                    className="player-volume__slider"
                    min="0" max="100" step="1"
                    value={volume}
                    onChange={(e) => setVol(Number(e.target.value))}
                    aria-label="音量"
                  />
                </div>
              </div>

              <div className="player-controls__group">
                {/* 播放速度 */}
                <div className="player-speed">
                  <button
                    className="player-ctrl-btn player-speed__btn"
                    aria-label="播放速度"
                    onClick={() => { setSpeedMenuOpen((o) => !o); setSettingsOpen(false) }}
                  >
                    <span className="mono" style={{ fontSize: 11 }}>{speed.toFixed(2).replace(/\.?0+$/, '')}x</span>
                  </button>
                  {speedMenuOpen && (
                    <div className="player-speed__menu">
                      {SPEEDS.map((s) => (
                        <button
                          key={s}
                          className={`player-speed__opt${s === speed ? ' is-active' : ''}`}
                          onClick={() => setSpeedRate(s)}
                        >
                          {s.toFixed(2).replace(/\.?0+$/, '')}x
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <button className={'player-ctrl-btn' + (fav ? ' is-active' : '')} aria-label="收藏" onClick={toggleFavorite}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill={fav ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></svg>
                </button>
                <button className="player-ctrl-btn" aria-label="画中画" onClick={pip}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M13 12h8v6h-8z" fill="currentColor" /></svg>
                </button>
                <button className="player-ctrl-btn" aria-label="全屏" onClick={fullscreen}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
                </button>
                <button className="player-ctrl-btn is-active" aria-label="播放列表" onClick={() => setSidebarCollapsed((c) => !c)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h18M3 12h18M3 16h18" /></svg>
                </button>
                <button className="player-ctrl-btn" aria-label="设置" onClick={() => { setSettingsOpen((o) => !o); setSpeedMenuOpen(false) }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                </button>
              </div>
            </div>
          </div>

          {/* ===== 设置面板 ===== */}
          {settingsOpen && (
            <div className="settings-panel">
              <div className="settings-panel__header">
                <span className="settings-panel__title">播放设置</span>
                <button className="settings-panel__close" aria-label="关闭设置" onClick={() => setSettingsOpen(false)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              </div>

              <div className="settings-panel__tabs ds-tabs ds-tabs--filled">
                {SETTING_TABS.map((t) => (
                  <button
                    key={t}
                    className={`ds-tab${settingsTab === t ? ' is-active' : ''}`}
                    onClick={() => setSettingsTab(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>

              <div className="settings-panel__body">
                {/* 视频 */}
                {settingsTab === '视频' && (
                  <>
                    <div className="settings-group">
                      <div className="settings-group__title">视频调节</div>
                      {[
                        { label: '亮度', val: brightness, set: setBrightness },
                        { label: '对比度', val: contrast, set: setContrast },
                        { label: '饱和度', val: saturation, set: setSaturation },
                        { label: '色调', val: hue, set: setHue }
                      ].map(({ label, val, set }) => (
                        <div className="setting-row" key={label}>
                          <span className="setting-row__label">{label}</span>
                          <input
                            type="range" className="setting-row__slider" min="0" max="100" step="1"
                            value={val} onChange={(e) => set(Number(e.target.value))}
                            aria-label={label}
                          />
                          <span className="setting-row__value">{val}</span>
                        </div>
                      ))}
                    </div>
                    <div className="settings-group">
                      <div className="settings-group__title">画质</div>
                      <div className="setting-row">
                        <span className="setting-row__label">清晰度</span>
                        <select
                          className="setting-select"
                          value={quality}
                          onChange={(e) => { setQuality(e.target.value); persist({ quality: e.target.value }) }}
                          aria-label="清晰度"
                          disabled
                        >
                          {QUALITIES.map((q) => <option key={q} value={q}>{q}</option>)}
                        </select>
                        <span className="setting-row__soon">即将支持</span>
                      </div>
                      <div className="setting-row">
                        <span className="setting-row__label">硬件加速</span>
                        <Switch label="硬件加速" on={hardwareAccel} onChange={(v) => { setHardwareAccel(v); persist({ hardwareDecode: v }) }} disabled />
                        <span className="setting-row__soon">即将支持</span>
                      </div>
                    </div>
                  </>
                )}

                {/* 音频 */}
                {settingsTab === '音频' && (
                  <>
                    <div className="settings-group">
                      <div className="settings-group__title">音频</div>
                      <div className="setting-row">
                        <span className="setting-row__label">音量增益</span>
                        <input type="range" className="setting-row__slider" min="0" max="200" step="1"
                          value={audioGain} onChange={(e) => setAudioGain(Number(e.target.value))} aria-label="音量增益" disabled />
                        <span className="setting-row__value">{audioGain}%</span>
                        <span className="setting-row__soon">即将支持</span>
                      </div>
                      <div className="setting-row">
                        <span className="setting-row__label">音频延迟</span>
                        <input type="range" className="setting-row__slider" min="-500" max="500" step="10"
                          value={audioDelay} onChange={(e) => setAudioDelay(Number(e.target.value))} aria-label="音频延迟" disabled />
                        <span className="setting-row__value">{audioDelay}ms</span>
                        <span className="setting-row__soon">即将支持</span>
                      </div>
                    </div>
                  </>
                )}

                {/* 字幕 */}
                {settingsTab === '字幕' && (
                  <>
                    <div className="settings-group">
                      <div className="settings-group__title">字幕</div>
                      {subtitleList.length > 1 && (
                        <div className="setting-row">
                          <span className="setting-row__label">字幕轨</span>
                          <select
                            className="setting-select"
                            value={subtitleIndex}
                            onChange={(e) => setSubtitleIndex(Number(e.target.value))}
                            aria-label="字幕轨"
                          >
                            {subtitleList.map((p, i) => (
                              <option key={i} value={i}>
                                {i === 0 ? '自动匹配' : `字幕 ${i + 1}`} · {String(p).split(/[\\/]/).pop()}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div className="setting-row">
                        <span className="setting-row__label">字幕大小</span>
                        <select className="setting-select" value={subSize} onChange={(e) => { setSubSize(e.target.value); persist({ subtitleFontSize: e.target.value }) }} aria-label="字幕大小">
                          <option value="small">小</option>
                          <option value="medium">中</option>
                          <option value="large">大</option>
                          <option value="xlarge">特大</option>
                        </select>
                      </div>
                      <div className="setting-row">
                        <span className="setting-row__label">字幕字体</span>
                        <span className="setting-select">思源黑体</span>
                        <span className="setting-row__soon">即将支持</span>
                      </div>
                      <div className="setting-row">
                        <span className="setting-row__label">字幕颜色</span>
                        <span className="setting-select">白色</span>
                        <span className="setting-row__soon">即将支持</span>
                      </div>
                    </div>
                  </>
                )}

                {/* 播放 */}
                {settingsTab === '播放' && (
                  <>
                    <div className="settings-group">
                      <div className="settings-group__title">播放</div>
                      <div className="setting-row">
                        <span className="setting-row__label">自动跳下一集</span>
                        <Switch label="自动跳下一集" on={autoNext} onChange={(v) => { setAutoNext(v); persist({ autoNextEpisode: v }) }} />
                      </div>
                      <div className="setting-row">
                        <span className="setting-row__label">跳过片头片尾</span>
                        <Switch label="跳过片头片尾" on={skipOpEd} onChange={(v) => { setSkipOpEd(v); persist({ skipOpEd: v }) }} />
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ===== 播放列表侧栏 ===== */}
        {!sidebarCollapsed && (
          <aside className="player-sidebar">
            <div className="player-sidebar__header">
              <span className="player-sidebar__title">播放队列 · {episodes.length} 集</span>
              <button className="player-sidebar__collapse" aria-label="收起" onClick={() => setSidebarCollapsed(true)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6" /></svg>
              </button>
            </div>

            <div className="player-sidebar__tabs">
              <div className="ds-tabs ds-tabs--filled">
                <button className={`ds-tab${sidebarTab === 'episodes' ? ' is-active' : ''}`} onClick={() => setSidebarTab('episodes')}>剧集</button>
                <button className={`ds-tab${sidebarTab === 'recommend' ? ' is-active' : ''}`} onClick={() => setSidebarTab('recommend')}>推荐</button>
              </div>
            </div>

            <div className="player-sidebar__content">
              {sidebarTab === 'episodes' ? (
                <ul className="ep-list">
                  {episodes.map((e) => {
                    const isPlaying = e.id === epId
                    const isNext = !e.watched && !isPlaying && nextEp?.id === e.id
                    const classes = [
                      'ep-item',
                      isPlaying ? 'is-playing' : '',
                      isNext ? 'is-next' : '',
                      e.watched ? 'is-watched' : ''
                    ].filter(Boolean).join(' ')
                    return (
                      <li key={e.id} className={classes} onClick={() => goEp(e.id)}>
                        <div className="ep-item__indicator">
                          {isPlaying ? (
                            <div className="ep-item__play-indicator"><span /><span /><span /></div>
                          ) : e.watched ? (
                            <svg className="icon ep-item__check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                          ) : null}
                        </div>
                        <span className="ep-item__num">{String(e.number ?? 0).padStart(2, '0')}</span>
                        <div className="ep-item__main">
                          <div className="ep-item__title">
                            {e.title || `第 ${e.number} 话`}
                            {isNext && <span className="ep-item__next-tag">下一集</span>}
                          </div>
                          <div className="ep-item__meta">
                            {e.duration > 0 && <span className="ep-item__duration">{formatTime(e.duration)}</span>}
                            {e.progress > 0 && !e.watched && e.duration > 0 && (
                              <span className="ep-item__duration">· {Math.round((e.progress / e.duration) * 100)}%</span>
                            )}
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <ul className="rec-list">
                  {library
                    .filter((a) => a.id !== anime.id)
                    .slice(0, 8)
                    .map((a) => (
                      <li key={a.id} className="rec-item" onClick={() => navigate(`/anime/${a.id}`)}>
                        <div className="rec-item__thumb" style={{ background: a.coverUrl ? 'none' : coverGradient(a.title) }}>
                          {a.coverUrl ? <img src={a.coverUrl} alt="" /> : null}
                        </div>
                        <div className="rec-item__info">
                          <div className="rec-item__title">{a.title}</div>
                          <div className="rec-item__meta">{a.episodes?.length || 0} 集</div>
                        </div>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}