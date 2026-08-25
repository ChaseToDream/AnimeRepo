import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import api from '../lib/api'
import Toasts from '../components/Toasts'
import { createTranslator } from '../lib/i18n'

const AppContext = createContext(null)

// 扫描进度独立 Context（P5 修复白屏卡死）：进度事件以 100ms 间隔高频推送，
// 若挂在全局 AppContext 的 value 上，每次进度更新都会使 context 引用变化，
// 导致所有 useApp() 消费者（ShellLayout/Sidebar/Library/Stats/Settings 等）
// 以 10Hz 全树重渲染——开发模式下单次渲染超 100ms 时渲染主线程被占满，
// 窗口被系统判定为未响应而白屏卡死。独立 Context 仅状态栏订阅，隔离高频更新。
const ScanProgressContext = createContext(null)

export function ScanProgressProvider({ children }) {
  const [progress, setProgress] = useState(null)
  useEffect(() => {
    return api.onScanProgress((info) => {
      if (!info) return
      // 主进程在扫描结束时推送 done：清空进度，避免残留旧值在下一次扫描开始时闪烁
      if (info.phase === 'done') setProgress(null)
      else setProgress(info)
    })
  }, [])
  return <ScanProgressContext.Provider value={progress}>{children}</ScanProgressContext.Provider>
}

export function useScanProgress() {
  return useContext(ScanProgressContext)
}

export function AppProvider({ children }) {
  const [library, setLibrary] = useState([])
  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [version, setVersion] = useState('1.0.0')
  // U2：全局 Toast
  const [toasts, setToasts] = useState([])
  const showToast = useCallback((message, type = 'info', duration = 2500) => {
    const id = Date.now() + Math.random().toString(36).slice(2, 6)
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, duration)
    return id
  }, [])
  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [lib, st, ver] = await Promise.all([
        api.getLibrary(),
        api.getSettings().catch(() => null),
        api.getVersion().catch(() => '1.0.0')
      ])
      if (lib) setLibrary(lib)
      if (st) setSettings(st)
      if (ver) setVersion(ver)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // B6：强调色在应用启动时即应用（不再依赖进入设置页），设置变更时同步生效
  useEffect(() => {
    if (settings?.accentColor) {
      document.documentElement.style.setProperty('--accent-color', settings.accentColor)
    }
  }, [settings?.accentColor])

  // N9：主题模式应用（深色 / 浅色 / 跟随系统）
  useEffect(() => {
    const mode = settings?.themeMode || '深色'
    const apply = (light) => {
      if (light) document.documentElement.dataset.theme = 'light'
      else delete document.documentElement.dataset.theme
    }
    if (mode === '跟随系统') {
      const mq = window.matchMedia('(prefers-color-scheme: light)')
      const handler = (e) => apply(e.matches)
      apply(mq.matches)
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
    apply(mode === '浅色')
  }, [settings?.themeMode])

  // 界面密度（紧凑/标准/宽松）：通过根节点 data-density 驱动 CSS 覆盖间距 token
  useEffect(() => {
    const mode = settings?.uiDensity || '标准'
    if (mode === '紧凑') document.documentElement.dataset.density = 'compact'
    else if (mode === '宽松') document.documentElement.dataset.density = 'comfortable'
    else delete document.documentElement.dataset.density
  }, [settings?.uiDensity])

  // 动画效果开关：关闭时禁用全局过渡/动画
  useEffect(() => {
    if (settings?.enableAnimations === false) document.documentElement.dataset.animations = 'off'
    else delete document.documentElement.dataset.animations
  }, [settings?.enableAnimations])

  // O4：扫描进度订阅已迁移至 ScanProgressProvider（独立 Context，见文件头部说明）

  // 启动时（若开启自动扫描且无数据）执行一次初始扫描
  useEffect(() => {
    async function maybeAutoScan() {
      if (loading) return
      if (settings?.autoScanOnStartup && library.length === 0) {
        try {
          setScanning(true)
          const res = await api.scanLibrary()
          if (res && !res.skipped) setLibrary(res.animes)
        } catch (e) {
          // 忽略
        } finally {
          setScanning(false)
        }
      }
    }
    maybeAutoScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

  const scan = useCallback(async () => {
    setScanning(true)
    try {
      const res = await api.scanLibrary()
      if (res) {
        // P5：与后台自动扫描互斥——已有扫描在进行时主进程返回 skipped，
        // 不覆盖当前库数据，仅提示稍候（进度由先发起的那次扫描负责刷新）
        if (res.skipped) {
          showToast('已有扫描正在进行，请稍候', 'info')
        } else {
          setLibrary(res.animes)
          showToast(
            `扫描完成：新增 ${res.added || 0} 部，更新 ${res.updated || 0} 部${res.removed ? `，移除 ${res.removed} 部` : ''}`,
            'success'
          )
        }
      }
      return res
    } finally {
      setScanning(false)
    }
  }, [showToast])

  const getAnime = useCallback((id) => library.find((a) => a.id === id) || null, [library])

  const updateAnime = useCallback(
    async (id, patch) => {
      const updated = await api.updateAnime(id, patch)
      if (updated) {
        setLibrary((prev) => prev.map((a) => (a.id === id ? updated : a)))
      }
      return updated
    },
    []
  )

  const removeAnime = useCallback(async (id) => {
    await api.removeAnime(id)
    setLibrary((prev) => prev.filter((a) => a.id !== id))
  }, [])

  // N4：批量操作（返回更新后的库）
  const batchAnime = useCallback(async (action, ids, payload) => {
    const updated = await api.batchAnime({ action, ids, payload })
    if (updated) setLibrary(updated)
    return updated
  }, [])

  // N3：合并 / 拆分番剧
  const mergeAnime = useCallback(async (fromId, toId) => {
    const updated = await api.mergeAnime(fromId, toId)
    if (updated) setLibrary(updated)
    return updated
  }, [])

  const splitAnime = useCallback(async (fromId, epIds, newTitle) => {
    const updated = await api.splitAnime(fromId, epIds, newTitle)
    if (updated) setLibrary(updated)
    return updated
  }, [])

  const setProgress = useCallback(
    async (animeId, epId, seconds, duration) => {
      const updated = await api.setProgress(animeId, epId, seconds, duration)
      if (updated) {
        setLibrary((prev) => prev.map((a) => (a.id === animeId ? updated : a)))
      }
      return updated
    },
    []
  )

  // P4-5：静默保存播放进度——只写主进程存储，不回流全局 library state，
  // 避免播放期间每 5 秒一次 setLibrary 触发全应用重渲染（仅退出/切换时用 setProgress 同步一次）
  const setProgressSilent = useCallback(async (animeId, epId, seconds, duration) => {
    await api.setProgress(animeId, epId, seconds, duration)
  }, [])

  const setWatched = useCallback(async (animeId, epId, watched) => {
    const updated = await api.setWatched(animeId, epId, watched)
    if (updated) {
      setLibrary((prev) => prev.map((a) => (a.id === animeId ? updated : a)))
    }
    return updated
  }, [])

  const updateSettings = useCallback(async (patch) => {
    const next = await api.updateSettings(patch)
    setSettings(next)
    return next
  }, [])

  const addFolder = useCallback(async () => {
    const folders = await api.addLibraryFolder()
    setSettings((prev) => (prev ? { ...prev, libraryFolders: folders } : prev))
    return folders
  }, [])

  const removeFolder = useCallback(async (folder) => {
    const folders = await api.removeLibraryFolder(folder)
    setSettings((prev) => (prev ? { ...prev, libraryFolders: folders } : prev))
    return folders
  }, [])

  // N7：基于 uiLanguage 的翻译函数
  const t = useMemo(() => createTranslator(settings?.uiLanguage), [settings?.uiLanguage])

  // P1-4.2：value 用 useMemo 包裹——toast 等高频状态变化时（其余 state 未变）保持 value 引用稳定，
  // 让所有 useApp 消费者跳过无谓重渲染（toasts 由 <Toasts> 组件直接通过 props 消费，不在 value 内）
  const value = useMemo(
    () => ({
      library,
      settings,
      loading,
      scanning,
      version,
      refresh,
      scan,
      getAnime,
      updateAnime,
      removeAnime,
      batchAnime,
      mergeAnime,
      splitAnime,
      setProgress,
      setProgressSilent,
      setWatched,
      updateSettings,
      addFolder,
      removeFolder,
      showToast,
      dismissToast,
      t,
      api
    }),
    [
      library,
      settings,
      loading,
      scanning,
      version,
      t,
      refresh,
      scan,
      getAnime,
      updateAnime,
      removeAnime,
      batchAnime,
      mergeAnime,
      splitAnime,
      setProgress,
      setProgressSilent,
      setWatched,
      updateSettings,
      addFolder,
      removeFolder,
      showToast,
      dismissToast
    ]
  )

  return (
    <AppContext.Provider value={value}>
      {/* P5：进度高频更新被隔离在 ScanProgressProvider 内，不触发 AppContext 消费者重渲染 */}
      <ScanProgressProvider>{children}</ScanProgressProvider>
      <Toasts toasts={toasts} dismiss={dismissToast} />
    </AppContext.Provider>
  )
}

export function useApp() {
  return useContext(AppContext)
}