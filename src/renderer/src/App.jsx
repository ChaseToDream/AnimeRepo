import { useEffect, useState } from 'react'

function App() {
  const [platform, setPlatform] = useState('')

  useEffect(() => {
    // 通过 preload 暴露的 api 读取平台信息
    setPlatform(window.api?.platform ?? '')
  }, [])

  return (
    <div className="app">
      <h1>Anime Repo</h1>
      <p>Electron + React + Vite 项目已成功初始化 🎉</p>
      <p>当前运行平台：{platform}</p>
      <div className="cards">
        <div className="card">Electron 主进程 / 预加载 / 渲染进程三层结构</div>
        <div className="card">热更新开发模式，开箱即用</div>
        <div className="card">支持打包为 Windows 安装程序</div>
      </div>
    </div>
  )
}

export default App