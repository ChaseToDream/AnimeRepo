import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 通过 contextBridge 暴露安全的 API 给渲染进程
const api = {
  // 在这里添加自定义的、暴露给渲染进程的 API
  platform: process.platform
}

// contextIsolation 开启时，安全地暴露 API
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}