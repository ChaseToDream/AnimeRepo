import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
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
  // O-04：观看日志（新的在前）
  const [history, setHistory] = useState([])
  // U2：全局 Toast
  const [toasts, setToasts] = useState([])
  // UX-3：批量操作撤销栈（上限 10 条），记录可撤销操作的原状态快照
  const undoStack = useRef([])
  const showToast = useCallback((message, type = 'info', duration = 2500, action = null) => {
    const id = Date.now() + Math.random().toString(36).slice(2, 6)
    setToasts((prev) => [...prev, { id, message, type, action }])
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

  // PF-02：增量合并工具——{ upserts, removedIds } 本地合并，
  // 替代原先「每次操作接收全量库再 setLibrary」的模式（大库 ≈ 10MB 级 IPC 开销）
  const applyDelta = useCallback((delta) => {
    if (!delta) return
    const { upserts, removedIds } = delta
    if (!upserts?.length && !removedIds?.length) return
    setLibrary((prev) => {
      let next = prev
      if (removedIds?.length) {
        const removeSet = new Set(removedIds)
        next = next.filter((a) => !removeSet.has(a.id))
      }
      if (upserts?.length) {
        const upsertMap = new Map(upserts.map((a) => [a.id, a]))
        next = next.map((a) => upsertMap.get(a.id) || a)
        // 新增条目（库中尚不存在）追加到末尾
        for (const a of upserts) {
          if (!next.some((x) => x.id === a.id)) next = [...next, a]
        }
      }
      return next
    })
  }, [])

  // PF-02：订阅后台自动扫描的库变更——此前后台扫描结果对 UI 不可见，
  // 需等用户手动刷新才能看到新增番剧/剧集
  useEffect(() => {
    if (!api?.onLibraryChanged) return undefined
    return api.onLibraryChanged((delta) => applyDelta(delta))
  }, [applyDelta])

  // O-04：拉取观看日志（历史/统计页挂载时调用；轻量，上限 500 条）
  const loadHistory = useCallback(async () => {
    try {
      const h = await api.getWatchHistory()
      if (Array.isArray(h)) setHistory(h)
    } catch (e) {
      /* 忽略 */
    }
  }, [])
  useEffect(() => {
    loadHistory()
  }, [loadHistory])

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

  // B-05 修复：启动时自动扫描——设置语义为「每次启动应用时自动扫描」，
  // 原实现加了 library.length === 0 条件导致仅首次生效；现按设置真实触发。
  // O-01 的增量扫描缓存（含磁盘持久化）保证了重启扫描也只遍历变更目录，开销可控。
  useEffect(() => {
    async function maybeAutoScan() {
      if (loading) return
      if (settings?.autoScanOnStartup && (settings?.libraryFolders || []).length > 0) {
        try {
          setScanning(true)
          const res = await api.scanLibrary()
          if (res && !res.skipped) applyDelta(res)
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
          // PF-02：增量合并（changedAnimes / removedIds），不再接收全量库
          applyDelta(res)
          if (res.aborted) {
            showToast('扫描已取消（已完成的变更已保留）', 'info')
          } else {
            // O-3：变更明细——把新增/更新的番剧标题带进提示（前 5 部），
            // 让用户一眼看到本次扫描实际改动了哪些条目。
            const changed = res.changedAnimes || []
            const detail = changed.length
              ? '：' + changed.slice(0, 5).map((a) => a.title).join('、') + (changed.length > 5 ? '…' : '')
              : ''
            showToast(
              `扫描完成：新增 ${res.added || 0} 部，更新 ${res.updated || 0} 部${res.removed ? `，移除 ${res.removed} 部` : ''}${detail}`,
              'success'
            )
          }
        }
      }
      return res
    } finally {
      setScanning(false)
    }
  }, [showToast, applyDelta])

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

  // N4：批量操作（PF-02：主进程返回增量，本地合并）
  // mark-watched 会在主进程追加观看日志，完成后刷新历史
  // UX-3：可撤销的批量操作（标记已看/未看、设状态、收藏、设标签）在改动前
  // 把受影响的番剧原状态存入撤销栈，供 undoLastBatch 精确回滚。
  const batchAnime = useCallback(async (action, ids, payload) => {
    const reversible = ['mark-watched', 'mark-unwatched', 'set-status', 'set-favorite', 'set-tags'].includes(action)
    let snapshot = null
    if (reversible && Array.isArray(ids) && ids.length) {
      snapshot = ids
        .map((id) => {
          const a = library.find((x) => x.id === id)
          if (!a) return null
          return {
            id,
            status: a.status,
            isFavorite: Boolean(a.isFavorite),
            tags: Array.isArray(a.tags) ? [...a.tags] : [],
            // 逐集原状态（撤销标记类操作时按集精确恢复）
            episodes: (a.episodes || []).map((e) => ({ id: e.id, watched: Boolean(e.watched), progress: e.progress || 0 }))
          }
        })
        .filter(Boolean)
    }
    const delta = await api.batchAnime({ action, ids, payload })
    applyDelta(delta)
    if (action === 'mark-watched') loadHistory()
    if (snapshot && snapshot.length) {
      undoStack.current.push({ action, snapshot })
      if (undoStack.current.length > 10) undoStack.current.shift()
    }
    return delta
  }, [applyDelta, loadHistory, library])

  // UX-3：撤销最近一次可撤销的批量操作（精确回滚到操作前状态）
  const undoLastBatch = useCallback(async () => {
    const entry = undoStack.current.pop()
    if (!entry) {
      showToast('没有可撤销的批量操作', 'info')
      return null
    }
    const updated = []
    for (const p of entry.snapshot) {
      const cur = library.find((x) => x.id === p.id)
      if (!cur) continue
      let next = null
      if (entry.action === 'mark-watched' || entry.action === 'mark-unwatched') {
        const epMap = new Map(p.episodes.map((e) => [e.id, e]))
        const episodes = (cur.episodes || []).map((e) => {
          const orig = epMap.get(e.id)
          return orig ? { ...e, watched: orig.watched, progress: orig.progress } : e
        })
        next = await api.updateAnime(p.id, { episodes })
      } else if (entry.action === 'set-status') {
        next = await api.updateAnime(p.id, { status: p.status })
      } else if (entry.action === 'set-favorite') {
        next = await api.updateAnime(p.id, { isFavorite: p.isFavorite })
      } else if (entry.action === 'set-tags') {
        next = await api.updateAnime(p.id, { tags: [...p.tags] })
      }
      if (next) updated.push(next)
    }
    // 本地状态统一回写
    if (updated.length) {
      setLibrary((prev) => prev.map((a) => updated.find((x) => x.id === a.id) || a))
    }
    if (entry.action === 'mark-watched' || entry.action === 'mark-unwatched') loadHistory()
    showToast('已撤销上一次批量操作', 'info')
    return true
  }, [library, setLibrary, loadHistory, showToast])

  // N3：合并 / 拆分番剧（PF-02：增量合并）
  const mergeAnime = useCallback(async (fromId, toId) => {
    const delta = await api.mergeAnime(fromId, toId)
    applyDelta(delta)
    return delta
  }, [applyDelta])

  const splitAnime = useCallback(async (fromId, epIds, newTitle) => {
    const delta = await api.splitAnime(fromId, epIds, newTitle)
    applyDelta(delta)
    return delta
  }, [applyDelta])

  // N-06：设置本地封面（主进程复制进封面缓存目录并更新 coverUrl）
  const setAnimeCover = useCallback(async (id, filePath) => {
    const updated = await api.setAnimeCover(id, filePath)
    if (updated) {
      setLibrary((prev) => prev.map((a) => (a.id === id ? updated : a)))
    }
    return updated
  }, [])

  const setProgress = useCallback(
    async (animeId, epId, seconds, duration) => {
      const updated = await api.setProgress(animeId, epId, seconds, duration)
      if (updated) {
        setLibrary((prev) => prev.map((a) => (a.id === animeId ? updated : a)))
        // O-04：播放至结尾自动标记已看会写观看日志
        loadHistory()
      }
      return updated
    },
    [loadHistory]
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
      // O-04：标记已看会写观看日志
      if (watched) loadHistory()
    }
    return updated
  }, [loadHistory])

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
      history,
      loadHistory,
      refresh,
      scan,
      getAnime,
      updateAnime,
      removeAnime,
      batchAnime,
      mergeAnime,
      splitAnime,
      setAnimeCover,
      setProgress,
      setProgressSilent,
      setWatched,
      updateSettings,
      addFolder,
      removeFolder,
      undoLastBatch,
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
      history,
      loadHistory,
      t,
      refresh,
      scan,
      getAnime,
      updateAnime,
      removeAnime,
      batchAnime,
      mergeAnime,
      splitAnime,
      setAnimeCover,
      setProgress,
      setProgressSilent,
      setWatched,
      updateSettings,
      addFolder,
      removeFolder,
      undoLastBatch,
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