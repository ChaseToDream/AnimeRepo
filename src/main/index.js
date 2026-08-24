import { app, shell, BrowserWindow, protocol, net } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { ensureDataFile } from './store'
import { registerIpc } from './ipc'

// 自定义协议：anime://local/<base64path> 用于安全加载本地视频
protocol.registerSchemesAsPrivileged([
  { scheme: 'anime', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

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

  // 自定义协议处理：anime://local/<base64path>
  protocol.handle('anime', (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'local') {
      try {
        const filePath = Buffer.from(url.pathname.slice(1), 'base64url').toString('utf-8')
        return net.fetch(pathToFileURL(filePath).toString())
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

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})