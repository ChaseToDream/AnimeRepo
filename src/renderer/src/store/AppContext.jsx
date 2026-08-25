import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import api from '../lib/api'
import Toasts from '../components/Toasts'
import { createTranslator } from '../lib/i18n'

const AppContext = createContext(null)

export function AppProvider({ children }) {
  const [library, setLibrary] = useState([])
  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState(null)
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

  // O4：订阅扫描进度事件（主进程在扫描过程中推送）
  useEffect(() => {
    return api.onScanProgress(setScanProgress)
  }, [])

  // 启动时（若开启自动扫描且无数据）执行一次初始扫描
  useEffect(() => {
    async function maybeAutoScan() {
      if (loading) return
      if (settings?.autoScanOnStartup && library.length === 0) {
        try {
          setScanning(true)
          setScanProgress(null)
          const res = await api.scanLibrary()
          if (res) setLibrary(res.animes)
        } catch (e) {
          // 忽略
        } finally {
          setScanning(false)
          setScanProgress(null)
        }
      }
    }
    maybeAutoScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

  const scan = useCallback(async () => {
    setScanning(true)
    setScanProgress(null)
    try {
      const res = await api.scanLibrary()
      if (res) {
        setLibrary(res.animes)
        showToast(
          `扫描完成：新增 ${res.added || 0} 部，更新 ${res.updated || 0} 部${res.removed ? `，移除 ${res.removed} 部` : ''}`,
          'success'
        )
      }
      return res
    } finally {
      setScanning(false)
      setScanProgress(null)
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

  const value = {
    library,
    settings,
    loading,
    scanning,
    scanProgress,
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
  }

  return (
    <AppContext.Provider value={value}>
      {children}
      <Toasts toasts={toasts} dismiss={dismissToast} />
    </AppContext.Provider>
  )
}

export function useApp() {
  return useContext(AppContext)
}