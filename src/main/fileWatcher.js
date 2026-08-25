// F-2 媒体库文件监控：监听库文件夹的文件系统变更（新增/删除/改名），
// 事件防抖合并后触发一次自动扫描（复用 autosync.runOnce，syncing 防重入，
// 加上增量扫描缓存，事件驱动的扫描开销可忽略）。
// 开关由 settings.fileWatchEnabled 控制；30s 定期对账，库文件夹在设置中
// 增删时自动重建 watcher。
import fs from 'fs'
import { getSettings } from './store'
import { runOnce as runAutoSync } from './autosync'

let watchers = new Map() // folder -> fs.FSWatcher
let debounceTimer = null
let reconcileTimer = null
let started = false

const EVENT_DEBOUNCE_MS = 800

function folderList() {
  return (getSettings().libraryFolders || []).filter(Boolean)
}

function onEvent() {
  // 高频事件（批量解压/复制等）合并为一次扫描；
  // V3-1：force=true——文件监控触发不受“启动时自动扫描”开关阻塞
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    runAutoSync(true)
  }, EVENT_DEBOUNCE_MS)
}

function watchOne(folder) {
  try {
    const w = fs.watch(folder, { recursive: true }, () => onEvent())
    watchers.set(folder, w)
  } catch (e) {
    /* 单个目录监听失败（不存在/无权限）：忽略，下次对账重试 */
  }
}

// 对账：按当前设置重建 watcher 集合（删除已移除的库文件夹、补齐新增的）
function reconcile() {
  if (!started) return
  const folders = folderList()
  for (const [folder, w] of watchers) {
    if (!folders.includes(folder)) {
      try { w.close() } catch (e) { /* ignore */ }
      watchers.delete(folder)
    }
  }
  for (const folder of folders) {
    if (!watchers.has(folder)) watchOne(folder)
  }
}

export function startFileWatch() {
  if (started) return
  started = true
  reconcile()
  reconcileTimer = setInterval(reconcile, 30000)
}

export function stopFileWatch() {
  started = false
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (reconcileTimer) {
    clearInterval(reconcileTimer)
    reconcileTimer = null
  }
  for (const [, w] of watchers) {
    try { w.close() } catch (e) { /* ignore */ }
  }
  watchers.clear()
}

// 设置变更（开关 / 库文件夹列表）后立即按新设置重启
export function restartFileWatch() {
  stopFileWatch()
  if (getSettings().fileWatchEnabled) startFileWatch()
}