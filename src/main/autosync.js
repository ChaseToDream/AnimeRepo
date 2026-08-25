// 自动同步（N2）：定期后台扫描媒体库，发现新番/新集时发送系统通知
// 由 autoScanOnStartup 开关控制（与「自动同步已开启」状态栏文案对应）
import { Notification, BrowserWindow } from 'electron'
import * as store from './store'
import { scanLibrary } from './scanner'

const SYNC_INTERVAL = 30 * 60 * 1000 // 30 分钟
const FIRST_DELAY = 60 * 1000 // 启动后 60s 首次检查（避免与启动扫描叠加）

let interval = null
let firstTimer = null
let syncing = false

function countEpisodes() {
  return store.list().reduce((n, a) => n + (a.episodes || []).length, 0)
}

// UX-08：通知点击除唤起窗口外，还携带目标路径通知渲染层导航——
// 新番通知直达其详情页，形成完整转化闭环
function notify(title, body, clickPath) {
  if (!Notification.isSupported()) return
  const win = BrowserWindow.getAllWindows()[0]
  const n = new Notification({ title, body })
  n.on('click', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      if (clickPath && !win.isDestroyed()) {
        win.webContents.send('app:navigate', clickPath)
      }
    }
  })
  n.show()
}

// F-2：文件监控（fileWatcher）也复用此入口——事件触发一次自动扫描，
// syncing 标志保证与定时同步/手动扫描互斥，不会并发双跑
// V3-1：force=true 跳过 autoScanOnStartup 检查（文件监控的“监控”开关
// 与“启动时自动扫描”语义独立，互不牵制）
export async function runOnce(force = false) {
  const settings = store.getSettings()
  if (syncing || (!force && !settings.autoScanOnStartup)) return
  const folders = settings.libraryFolders || []
  if (!folders.length) return
  syncing = true
  try {
    const before = countEpisodes()
    const res = await scanLibrary(store, folders, settings)
    const after = countEpisodes()
    const addedAnime = res.added || 0
    const updatedAnime = res.updated || 0
    const removedAnime = res.removed || 0
    const newEpisodes = Math.max(0, after - before)
    // PF-02：后台扫描的变更以增量事件推送给渲染进程本地合并——
    // 此前后台扫描结果对 UI 完全不可见，需手动刷新才能看到新增番剧
    if ((res.changedAnimes && res.changedAnimes.length) || (res.removedIds && res.removedIds.length)) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('library:changed', {
            upserts: res.changedAnimes || [],
            removedIds: res.removedIds || []
          })
        }
      }
    }
    if (addedAnime > 0 || updatedAnime > 0 || removedAnime > 0) {
      const parts = []
      if (addedAnime) parts.push(`发现 ${addedAnime} 部新番剧`)
      if (updatedAnime) parts.push(`${updatedAnime} 部番剧更新${newEpisodes ? `（新增 ${newEpisodes} 集）` : ''}`)
      if (removedAnime) parts.push(`移除 ${removedAnime} 部失效条目`)
      // UX-08：优先定位到首个新增番剧的详情页
      const firstAdded = res.changedAnimes && res.changedAnimes[0]
      notify('AnimeRepo · 媒体库更新', parts.join('，'), firstAdded ? `/anime/${firstAdded.id}` : undefined)
    }
  } catch (e) {
    // 后台扫描失败静默忽略，不影响用户操作
  } finally {
    syncing = false
  }
}

export function startAutoSync() {
  stopAutoSync()
  firstTimer = setTimeout(runOnce, FIRST_DELAY)
  interval = setInterval(runOnce, SYNC_INTERVAL)
}

export function stopAutoSync() {
  if (firstTimer) {
    clearTimeout(firstTimer)
    firstTimer = null
  }
  if (interval) {
    clearInterval(interval)
    interval = null
  }
}

// 设置变化后可手动触发一次检查（如新增媒体库后）
export function triggerAutoSync() {
  if (!syncing) runOnce()
}
