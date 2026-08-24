import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  // 主进程
  main: {
    build: {
      outDir: 'out/main'
    }
  },
  // 预加载脚本
  preload: {
    build: {
      outDir: 'out/preload'
    }
  },
  // 渲染进程（React）
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})