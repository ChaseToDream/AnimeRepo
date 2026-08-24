import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import api from '../lib/api'

const AppContext = createContext(null)

export function AppProvider({ children }) {
  const [library, setLibrary] = useState([])
  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState(null)
  const [version, setVersion] = useState('1.0.0')

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
      if (res) setLibrary(res.animes)
      return res
    } finally {
      setScanning(false)
      setScanProgress(null)
    }
  }, [])

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
    setProgress,
    setWatched,
    updateSettings,
    addFolder,
    removeFolder,
    api
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp() {
  return useContext(AppContext)
}