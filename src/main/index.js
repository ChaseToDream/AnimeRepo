import { app, shell, BrowserWindow, protocol, net } from 'electron'
import { join, resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { ensureDataFile, getSettings, list, flushSaveSync } from './store'
import { registerIpc } from './ipc'
import { VIDEO_EXT } from './scanner'
import { getCoverDir, cleanupUnusedCovers } from './coverCache'
import { startAutoSync, stopAutoSync } from './autosync'

// 自定义协议：anime://local/<base64path> 用于安全加载本地视频
protocol.registerSchemesAsPrivileged([
  { scheme: 'anime', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

// 正则转义：构建扩展名白名单时防止用户输入的正则元字符破坏匹配
function escapeRe(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// B7 安全校验：仅允许读取「媒体库文件夹内」且为受支持扩展名的视频文件
// B4：扩展名白名单以 settings.videoFormats 为准（与扫描器保持一致），无配置时回退内置 VIDEO_EXT
function isAllowedMedia(filePath) {
  try {
    if (!filePath) return false
    const folders = getSettings().libraryFolders || []
    if (!folders.length) return false
    const resolved = resolve(filePath).toLowerCase()
    const inFolder = folders.some((f) => {
      const base = resolve(f).toLowerCase()
      return resolved === base || resolved.startsWith(base + sep)
    })
    if (!inFolder) return false
    const formats = (getSettings().videoFormats || []).filter(Boolean)
    if (formats.length) {
      const re = new RegExp(`\\.(${formats.map(escapeRe).join('|')})$`, 'i')
      return re.test(filePath)
    }
    return VIDEO_EXT.test(filePath)
  } catch (e) {
    return false
  }
}

// B-5：解析 anime://cover/<base64> URL → 对应封面缓存文件名（hash.ext）。
// 供启动时封面清理收集「仍在引用」的封面集合；非法/非封面 URL 返回 null。
function coverCacheName(url) {
  try {
    if (typeof url !== 'string' || !url.startsWith('anime://cover/')) return null
    return Buffer.from(url.slice('anime://cover/'.length), 'base64url').toString('utf-8')
  } catch (e) {
    return null
  }
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    title: 'AnimeRepo · 溯番',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 自定义协议处理：anime://local/<base64path> 视频 / anime://cover/<base64文件名> 封面缓存
  protocol.handle('anime', (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'local') {
      try {
        const filePath = Buffer.from(url.pathname.slice(1), 'base64url').toString('utf-8')
        // B7：越权读取防护——仅放行媒体库内的视频文件
        if (!isAllowedMedia(filePath)) return new Response('forbidden', { status: 403 })
        return net.fetch(pathToFileURL(filePath).toString())
      } catch (e) {
        return new Response('bad request', { status: 400 })
      }
    }
    if (url.hostname === 'cover') {
      try {
        const coverDir = resolve(getCoverDir()).toLowerCase()
        const filePath = Buffer.from(url.pathname.slice(1), 'base64url').toString('utf-8')
        const file = resolve(coverDir, filePath)
        // 校验：解析后必须仍位于封面缓存目录内
        if (file.toLowerCase().startsWith(coverDir + sep)) {
          return net.fetch(pathToFileURL(file).toString())
        }
        return new Response('forbidden', { status: 403 })
      } catch (e) {
        return new Response('bad request', { status: 400 })
      }
    }
    return new Response('not found', { status: 404 })
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.animerepo')
  ensureDataFile()
  registerIpc()

  // B-5：清理未被引用的历史封面缓存（异步执行，不阻塞启动）。
  // 从库内所有番剧的 coverUrl 解码出仍在引用的缓存文件名，其余删除。
  const coverRefs = []
  for (const a of list()) {
    const name = coverCacheName(a && a.coverUrl)
    if (name) coverRefs.push(name)
  }
  cleanupUnusedCovers(coverRefs)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // N2：启动定时后台扫描（由 autoScanOnStartup 开关控制）
  startAutoSync()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// P4-3：退出前同步落盘，避免异步合并写未完成导致数据丢失
app.on('before-quit', () => {
  flushSaveSync()
})

// N2：退出时停止定时后台扫描
app.on('will-quit', () => {
  stopAutoSync()
})