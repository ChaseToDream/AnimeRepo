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

function notify(title, body) {
  if (!Notification.isSupported()) return
  const win = BrowserWindow.getAllWindows()[0]
  const n = new Notification({ title, body })
  n.on('click', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
  n.show()
}

async function runOnce() {
  const settings = store.getSettings()
  if (syncing || !settings.autoScanOnStartup) return
  const folders = settings.libraryFolders || []
  if (!folders.length) return
  syncing = true
  try {
    const before = countEpisodes()
    const res = await scanLibrary(store, folders, settings)
    const after = countEpisodes()
    const addedAnime = res.added || 0
    const updatedAnime = res.updated || 0
    const newEpisodes = Math.max(0, after - before)
    if (addedAnime > 0 || updatedAnime > 0) {
      const parts = []
      if (addedAnime) parts.push(`发现 ${addedAnime} 部新番剧`)
      if (updatedAnime) parts.push(`${updatedAnime} 部番剧更新${newEpisodes ? `（新增 ${newEpisodes} 集）` : ''}`)
      notify('AnimeRepo · 媒体库更新', parts.join('，'))
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
