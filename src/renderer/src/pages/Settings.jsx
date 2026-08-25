import { useState, useEffect, useCallback } from 'react'
import { useApp } from '../store/AppContext'
import { ConfirmDialog } from '../components/Dialog'
import './Settings.css'

// 恢复默认时用到的主要设置默认值（与主进程 DEFAULT_SETTINGS 保持一致）
const DEFAULTS = {
  autoScanOnStartup: true,
  scanSubtitle: false,
  autoDownload: true,
  scanDepth: '深度扫描',
  recognizeMode: '自动识别',
  regexPattern: '\\[(.*?)\\]\\s*(.+?)\\s*-\\s*(\\d+)',
  preferLocalInfo: true,
  cleanupOnScan: true,
  unmatchedAction: '保留在未分类中',
  autoNextEpisode: true,
  skipOpEd: true,
  hardwareDecode: true,
  externalPlayerPath: '',
  defaultPlaySpeed: 1.0,
  subtitleFontSize: 'medium',
  fileWatchEnabled: true,
  subtitleFont: '思源黑体',
  subtitleStroke: true,
  subtitleBottomMargin: 60,
  preferredSubtitleLang: '简体中文',
  preferredAudioLang: '日语',
  defaultVolume: 80,
  audioGain: false,
  outputDevice: '系统默认',
  themeMode: '深色',
  accentColor: '#32F08C',
  posterDisplayMode: '竖版海报',
  uiDensity: '标准',
  enableAnimations: true,
  uiLanguage: '简体中文',
  dateFormat: 'YYYY-MM-DD',
  ratingSystem: '10分制',
  webServerEnabled: false,
  webServerPort: 39282,
  webServerBindAll: false
}

const ACCENTS = ['#32F08C', '#3B82F6', '#EF4444', '#F59E0B', '#8B5CF6', '#EC4899']

const NAV_GROUPS = [
  { title: '通用', items: [{ key: 'library', label: '番剧库' }, { key: 'scan', label: '扫描设置' }] },
  { title: '播放', items: [{ key: 'player', label: '播放器' }, { key: 'subtitle', label: '字幕' }, { key: 'audio', label: '音频' }] },
  { title: '界面', items: [{ key: 'appearance', label: '外观' }, { key: 'language', label: '语言' }] },
  { title: '高级', items: [{ key: 'webserve', label: '局域网播放' }, { key: 'data', label: '数据管理' }, { key: 'about', label: '关于' }] }
]

const SECTION_INFO = {
  library: { title: '番剧库', desc: '管理媒体库文件夹与番剧扫描相关设置。' },
  scan: { title: '扫描设置', desc: '自定义扫描行为、支持的格式与文件匹配规则。' },
  player: { title: '播放器', desc: '控制视频播放行为。' },
  subtitle: { title: '字幕', desc: '配置字幕的显示样式与语言偏好。' },
  audio: { title: '音频', desc: '配置音轨与音频输出偏好。' },
  appearance: { title: '外观', desc: '设置应用的主题与界面密度。' },
  language: { title: '语言', desc: '选择界面语言与日期、评分显示格式。' },
  webserve: { title: '局域网播放', desc: '在本机启动只读 HTTP 服务，供局域网设备浏览器观看媒体库视频。' },
  data: { title: '数据管理', desc: '导出、导入、重建或重置应用数据。' },
  about: { title: '关于', desc: '应用版本与许可信息。' }
}

// —— 小工具控件 ——
function SettingRow({ title, desc, control }) {
  return (
    <div className="ds-settingrow">
      <div className="ds-settingrow__main">
        {title && <span className="ds-settingrow__title">{title}</span>}
        {desc && <span className="ds-settingrow__desc">{desc}</span>}
      </div>
      <div className="ds-settingrow__control">{control}</div>
    </div>
  )
}

function Switch({ checked, onChange, disabled }) {
  return (
    <label className="ds-switch" style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
      <input type="checkbox" checked={Boolean(checked)} disabled={disabled} onChange={(e) => !disabled && onChange(e.target.checked)} />
      <span className="ds-switch__thumb" />
    </label>
  )
}

function Select({ value, options, onChange, width, disabled }) {
  const display = (o) => (typeof o === 'object' ? o.value : o)
  const label = (o) => (typeof o === 'object' ? o.label : o)
  // B-07：支持单项禁用（如未上线的语言选项）
  const itemDisabled = (o) => typeof o === 'object' && Boolean(o.disabled)
  return (
    <select
      className="ds-select"
      style={width ? { width } : undefined}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={display(o)} value={display(o)} disabled={itemDisabled(o)}>{label(o)}</option>
      ))}
    </select>
  )
}

// 可编辑标签列表（视频格式 / 信息格式）：默认显示标签，点击“编辑”切换为逗号分隔输入框
function EditableTags({ value = [], onChange }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')

  const startEdit = () => {
    setText(value.join(', '))
    setEditing(true)
  }
  const commit = () => {
    const next = text
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    onChange(next)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="ds-input" style={{ width: 200 }}>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        />
      </div>
    )
  }
  return (
    <div className="ds-taglist">
      {(value || []).map((v) => (
        <span key={v} className="ds-tag ds-tag--neutral-strong">{String(v).toUpperCase()}</span>
      ))}
      <button className="ds-btn ds-btn--sm ds-btn--secondary" onClick={startEdit}>编辑</button>
    </div>
  )
}

export default function Settings() {
  const { settings, updateSettings, addFolder, removeFolder, refresh, version, api, library, showToast } = useApp()
  const [activeSection, setActiveSection] = useState('library')
  // B-7：更新源是否已配置（未配置时隐藏「检查更新」入口，避免无意义占位按钮）
  const [updateSourceConfigured, setUpdateSourceConfigured] = useState(true)
  useEffect(() => {
    api.hasUpdateSource().then((v) => setUpdateSourceConfigured(v !== false)).catch(() => {})
  }, [])
  // F-4：局域网播放服务信息（状态 / 端口 / 访问地址）
  const [webInfo, setWebInfo] = useState(null)
  const refreshWebInfo = useCallback(async () => {
    try {
      const info = await api.getWebInfo()
      if (info) setWebInfo(info)
    } catch (e) {
      /* 忽略 */
    }
  }, [])
  useEffect(() => { refreshWebInfo() }, [refreshWebInfo])
  const toggleWebServer = async (enabled) => {
    const info = await api.setWebServerEnabled(enabled)
    setWebInfo(info)
    if (enabled) {
      showToast(info && info.status === '运行中' ? '局域网播放已开启' : `启动失败：${info && info.status}`, info && info.status === '运行中' ? 'success' : 'error')
    } else {
      showToast('局域网播放已关闭', 'info')
    }
  }
  const applyWebConfig = async (patch) => {
    const info = await api.updateWebServerConfig(patch)
    setWebInfo(info)
    showToast('局域网播放设置已应用', 'info')
  }
  const handleResetToken = async () => {
    const info = await api.resetWebToken()
    setWebInfo(info)
    showToast('访问令牌已重置，旧地址已失效', 'success')
  }
  // B-03：应用内确认对话框状态（替换原生 confirm）
  const [rebuildConfirmOpen, setRebuildConfirmOpen] = useState(false)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [defaultsConfirmOpen, setDefaultsConfirmOpen] = useState(false)

  // 加载时与强调色变化时同步 CSS 变量
  useEffect(() => {
    if (settings?.accentColor) {
      document.documentElement.style.setProperty('--accent-color', settings.accentColor)
    }
  }, [settings?.accentColor])

  if (!settings) return null

  const set = (patch) => updateSettings(patch)
  const applyAccent = (color) => {
    document.documentElement.style.setProperty('--accent-color', color)
    set({ accentColor: color })
  }

  const handleExport = async () => {
    const ok = await api.exportData()
    showToast(ok ? '数据已导出' : '导出已取消', ok ? 'success' : 'info')
  }
  // B-06：主进程导入返回 { ok, imported, skipped }，区分取消 / 失败 / 成功（含剔除统计）
  const handleImport = async () => {
    const res = await api.importData()
    if (!res) {
      showToast('导入已取消', 'info')
      return
    }
    if (!res.ok) {
      showToast('导入失败：文件格式无效', 'error')
      return
    }
    refresh()
    showToast(
      res.skipped > 0
        ? `已导入 ${res.imported} 部番剧，跳过 ${res.skipped} 条无效数据`
        : `已导入 ${res.imported} 部番剧`,
      res.skipped > 0 ? 'warning' : 'success'
    )
  }
  // B-03：以下三处由原生 confirm 改为应用内 ConfirmDialog
  const handleRebuild = () => setRebuildConfirmOpen(true)
  const confirmRebuild = async () => {
    setRebuildConfirmOpen(false)
    await api.rebuildDatabase()
    refresh()
    showToast('数据库已重建', 'success')
  }
  const handleReset = () => setResetConfirmOpen(true)
  const confirmReset = async () => {
    setResetConfirmOpen(false)
    await api.resetData()
    refresh()
    showToast('所有数据已重置', 'success')
  }
  const handleRestoreDefaults = () => setDefaultsConfirmOpen(true)
  const confirmRestoreDefaults = async () => {
    setDefaultsConfirmOpen(false)
    // F-4：局域网播放默认关闭——恢复默认时同步停掉正在运行的服务
    if (settings.webServerEnabled) {
      const info = await api.setWebServerEnabled(false)
      setWebInfo(info)
    }
    updateSettings({ ...DEFAULTS })
    showToast('已恢复默认设置', 'success')
  }

  // 媒体库文件夹计数（按路径前缀粗略统计）
  const folderCount = (path) =>
    library.filter((a) => (a.filePath || '').startsWith(path) || (a.path || '').startsWith(path)).length

  const section = SECTION_INFO[activeSection]

  return (
    <div className="settings">
      <nav className="settings-nav">
        {NAV_GROUPS.map((g) => (
          <div className="ds-navlist__group" key={g.title}>
            <div className="ds-navlist__group-title">{g.title}</div>
            {g.items.map((it) => (
              <button
                key={it.key}
                className={'ds-navlist__item' + (activeSection === it.key ? ' is-active' : '')}
                onClick={() => setActiveSection(it.key)}
              >
                <span className="ds-navlist__label">{it.label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="settings-main">
        <div className="settings-scroll">
          <div className="settings-pagehead">
            <h1 className="settings-pagehead__title">{section.title}</h1>
            <p className="settings-pagehead__desc">{section.desc}</p>
          </div>

          {/* ══ 番剧库 ══ */}
          {activeSection === 'library' && (
            <div className="ds-settingrow__group">
              <span className="ds-settingrow__grouplabel">媒体库文件夹</span>
              <div className="ds-settingrow__panel">
                {(settings.libraryFolders || []).map((f) => (
                  <div className="ds-folderrow" key={f}>
                    <div className="ds-folderrow__main">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon" style={{ color: 'var(--icon-secondary)', flexShrink: 0 }}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                      <span className="ds-folderrow__path">{f}</span>
                    </div>
                    <div className="ds-folderrow__actions">
                      <span className="ds-tag ds-tag--count">{folderCount(f)} 部</span>
                      <button
                        className="ds-btn ds-btn--sm ds-btn--icon ds-btn--tertiary"
                        aria-label="移除"
                        onClick={() => removeFolder(f)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
                      </button>
                    </div>
                  </div>
                ))}
                <div className="ds-settingrow__panel-footer">
                  <button className="ds-btn ds-btn--secondary" onClick={() => addFolder()}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon"><path d="M12 5v14M5 12h14" /></svg>
                    添加文件夹
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ══ 扫描设置 ══ */}
          {activeSection === 'scan' && (
            <>
              <div className="ds-settingrow__group">
                <span className="ds-settingrow__grouplabel">扫描选项</span>
                <div className="ds-settingrow__panel">
                  <SettingRow
                    title="启动时自动扫描"
                    desc="每次启动应用时自动扫描所有库文件夹中的新文件"
                    control={<Switch checked={settings.autoScanOnStartup} onChange={(v) => set({ autoScanOnStartup: v })} />}
                  />
                  <SettingRow
                    title="扫描时检测字幕文件"
                    desc="自动检测同目录下的字幕文件并关联到视频"
                    control={<Switch checked={settings.scanSubtitle} onChange={(v) => set({ scanSubtitle: v })} />}
                  />
                  <SettingRow
                    title="自动下载番剧信息"
                    desc="扫描时自动从网络获取番剧封面、简介等元数据"
                    control={<Switch checked={settings.autoDownload} onChange={(v) => set({ autoDownload: v })} />}
                  />
                  <SettingRow
                    title="扫描时清理失效条目"
                    desc="移除磁盘上已删除番剧的条目；关闭后扫描仅新增/更新，不清理旧数据"
                    control={<Switch checked={settings.cleanupOnScan} onChange={(v) => set({ cleanupOnScan: v })} />}
                  />
                  {/* F-2：媒体库文件夹文件监控 */}
                  <SettingRow
                    title="监控文件变化自动同步"
                    desc="库文件夹内新增/删除/改名文件时自动触发扫描（无需等待定时同步）"
                    control={<Switch checked={settings.fileWatchEnabled} onChange={(v) => set({ fileWatchEnabled: v })} />}
                  />
                  <SettingRow
                    title="扫描深度"
                    desc="设置扫描子目录的层级深度"
                    control={
                      <Select
                        value={settings.scanDepth}
                        options={['深度扫描', '仅当前目录', '一层子目录', '两层子目录']}
                        onChange={(v) => set({ scanDepth: v })}
                        width={180}
                      />
                    }
                  />
                  <SettingRow
                    title="支持的视频格式"
                    desc="被识别为视频文件的扩展名"
                    control={
                      <EditableTags
                        value={settings.videoFormats}
                        onChange={(v) => set({ videoFormats: v })}
                      />
                    }
                  />
                  <SettingRow
                    title="信息文件格式"
                    desc="本地番剧信息文件的扩展名"
                    control={
                      <EditableTags
                        value={settings.infoFormats}
                        onChange={(v) => set({ infoFormats: v })}
                      />
                    }
                  />
                </div>
              </div>

              <div className="ds-settingrow__group">
                <span className="ds-settingrow__grouplabel">文件匹配规则</span>
                <div className="ds-settingrow__panel">
                  <SettingRow
                    title="文件名识别模式"
                    desc="从文件名中提取番剧名和集数的方式"
                    control={
                      <Select
                        value={settings.recognizeMode}
                        options={['自动识别', '正则表达式']}
                        onChange={(v) => set({ recognizeMode: v })}
                        width={180}
                      />
                    }
                  />
                  <SettingRow
                    title="正则表达式匹配"
                    desc="自定义正则表达式来解析文件名"
                    control={
                      <div className="ds-input" style={{ width: 280 }}>
                        <input
                          type="text"
                          value={settings.regexPattern || ''}
                          onChange={(e) => set({ regexPattern: e.target.value })}
                          onBlur={(e) => set({ regexPattern: e.target.value })}
                        />
                      </div>
                    }
                  />
                  <SettingRow
                    title="优先使用本地信息文件"
                    desc="当存在本地 NFO 等信息文件时，优先使用其数据"
                    control={<Switch checked={settings.preferLocalInfo} onChange={(v) => set({ preferLocalInfo: v })} />}
                  />
                  <SettingRow
                    title="未匹配文件处理方式"
                    desc="无法识别的视频文件如何处理"
                    control={
                      <Select
                        value={settings.unmatchedAction}
                        options={['保留在未分类中', '自动忽略', '移至回收站']}
                        onChange={(v) => set({ unmatchedAction: v })}
                        width={180}
                      />
                    }
                  />
                </div>
              </div>
            </>
          )}

          {/* ══ 播放器 ══ */}
          {activeSection === 'player' && (
            <div className="ds-settingrow__group">
              <div className="ds-settingrow__panel">
                <SettingRow
                  title="自动播放下一集"
                  desc="播放完当前集后自动播放下一集"
                  control={<Switch checked={settings.autoNextEpisode} onChange={(v) => set({ autoNextEpisode: v })} />}
                />
                <SettingRow
                  title="跳过片头片尾"
                  desc="自动跳过片头和片尾"
                  control={<Switch checked={settings.skipOpEd} onChange={(v) => set({ skipOpEd: v })} />}
                />
                <SettingRow
                  title="硬件加速解码"
                  desc="使用 GPU 硬件加速视频解码（即将支持）"
                  control={<Switch checked={settings.hardwareDecode} onChange={(v) => set({ hardwareDecode: v })} disabled />}
                />
                {/* N-02：外部播放器——内置 <video> 不支持 HEVC/Hi10P 等编码，配置后可在播放页一键唤起 */}
                <SettingRow
                  title="外部播放器"
                  desc={
                    settings.externalPlayerPath
                      ? `已配置：${settings.externalPlayerPath}（播放页可一键唤起，适合 HEVC/Hi10P 等内置播放器不支持的编码）`
                      : '未配置。配置 mpv / VLC 等播放器后，可在播放页用外部播放器打开（适合 HEVC/Hi10P 等内置播放器不支持的编码）'
                  }
                  control={
                    <div className="settings-player-row">
                      <button
                        className="ds-btn ds-btn--secondary"
                        onClick={async () => {
                          const p = await api.pickExecutable()
                          if (p) {
                            set({ externalPlayerPath: p })
                            showToast('外部播放器已配置', 'success')
                          }
                        }}
                      >
                        选择程序…
                      </button>
                      {settings.externalPlayerPath && (
                        <button
                          className="ds-btn ds-btn--link"
                          onClick={() => set({ externalPlayerPath: '' })}
                        >
                          清除
                        </button>
                      )}
                    </div>
                  }
                />
                <SettingRow
                  title="默认播放速度"
                  desc="打开视频时的默认播放速度"
                  control={
                    <Select
                      value={Number(settings.defaultPlaySpeed).toFixed(2)}
                      options={[
                        { value: '0.50', label: '0.5x' },
                        { value: '0.75', label: '0.75x' },
                        { value: '1.00', label: '1.0x（正常）' },
                        { value: '1.25', label: '1.25x' },
                        { value: '1.50', label: '1.5x' },
                        { value: '2.00', label: '2.0x' }
                      ]}
                      onChange={(v) => set({ defaultPlaySpeed: Number(v) })}
                      width={180}
                    />
                  }
                />
              </div>
            </div>
          )}

          {/* ══ 字幕 ══ */}
          {activeSection === 'subtitle' && (
            <div className="ds-settingrow__group">
              <div className="ds-settingrow__panel">
                <SettingRow
                  title="字幕字体大小"
                  desc="字幕的显示大小"
                  control={
                    <Select
                      value={settings.subtitleFontSize}
                      options={['small', 'medium', 'large', 'xlarge']}
                      onChange={(v) => set({ subtitleFontSize: v })}
                      width={180}
                    />
                  }
                />
                <SettingRow
                  title="字幕字体"
                  desc="字幕使用的字体"
                  control={
                    <Select
                      value={settings.subtitleFont}
                      options={['思源黑体', '微软雅黑', '苹方', 'Noto Sans CJK']}
                      onChange={(v) => set({ subtitleFont: v })}
                      width={180}
                    />
                  }
                />
                <SettingRow
                  title="字幕描边"
                  desc="为字幕添加黑色描边以提高可读性"
                  control={<Switch checked={settings.subtitleStroke} onChange={(v) => set({ subtitleStroke: v })} />}
                />
                <SettingRow
                  title="字幕底部边距"
                  desc="字幕距离底部的像素距离"
                  control={
                    <div className="ds-input settings-number-input">
                      <input
                        type="number"
                        min="0"
                        max="500"
                        value={settings.subtitleBottomMargin}
                        onChange={(e) => set({ subtitleBottomMargin: Number(e.target.value) || 0 })}
                      />
                      <span className="settings-number-suffix">px</span>
                    </div>
                  }
                />
                <SettingRow
                  title="首选字幕语言"
                  desc="多字幕轨道时优先选择匹配的语言"
                  control={
                    <Select
                      value={settings.preferredSubtitleLang}
                      options={['简体中文', '繁体中文', '日文', '英文']}
                      onChange={(v) => set({ preferredSubtitleLang: v })}
                      width={180}
                    />
                  }
                />
              </div>
            </div>
          )}

          {/* ══ 音频 ══ */}
          {activeSection === 'audio' && (
            <div className="ds-settingrow__group">
              <div className="ds-settingrow__panel">
                <SettingRow
                  title="首选音轨语言"
                  desc="多音轨时的优先选择"
                  control={
                    <Select
                      value={settings.preferredAudioLang}
                      options={['日语', '普通话', '粤语', '英语']}
                      onChange={(v) => set({ preferredAudioLang: v })}
                      width={180}
                    />
                  }
                />
                <SettingRow
                  title="默认音量"
                  desc="打开视频时的默认音量"
                  control={
                    <div className="settings-volume">
                      <span className="mono settings-volume__value">{settings.defaultVolume}</span>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={settings.defaultVolume}
                        onChange={(e) => set({ defaultVolume: Number(e.target.value) })}
                      />
                    </div>
                  }
                />
                <SettingRow
                  title="音频增益"
                  desc="开启音频增益以提升低音量视频（即将支持）"
                  control={<Switch checked={settings.audioGain} onChange={(v) => set({ audioGain: v })} disabled />}
                />
                <SettingRow
                  title="输出设备"
                  desc="音频输出设备（即将支持）"
                  control={
                    <Select
                      value={settings.outputDevice}
                      options={['系统默认', 'HDMI', '扬声器', '耳机']}
                      onChange={(v) => set({ outputDevice: v })}
                      width={180}
                      disabled
                    />
                  }
                />
              </div>
            </div>
          )}

          {/* ══ 外观 ══ */}
          {activeSection === 'appearance' && (
            <div className="ds-settingrow__group">
              <div className="ds-settingrow__panel">
                <SettingRow
                  title="主题模式"
                  desc="应用的界面主题"
                  control={
                    <Select
                      value={settings.themeMode}
                      options={['深色', '浅色', '跟随系统']}
                      onChange={(v) => set({ themeMode: v })}
                      width={180}
                    />
                  }
                />
                <SettingRow
                  title="强调色"
                  desc="界面的强调色方案"
                  control={
                    <div className="settings-accents">
                      {ACCENTS.map((c) => (
                        <button
                          key={c}
                          className={'settings-accent' + (settings.accentColor === c ? ' is-active' : '')}
                          style={{ background: c }}
                          onClick={() => applyAccent(c)}
                          aria-label={c}
                        />
                      ))}
                    </div>
                  }
                />
                <SettingRow
                  title="海报显示模式"
                  desc="番剧封面的显示方向（即将支持）"
                  control={
                    <Select
                      value={settings.posterDisplayMode}
                      options={['竖版海报', '横版封面']}
                      onChange={(v) => set({ posterDisplayMode: v })}
                      width={180}
                      disabled
                    />
                  }
                />
                <SettingRow
                  title="界面密度"
                  desc="界面元素的间距密度"
                  control={
                    <Select
                      value={settings.uiDensity}
                      options={['紧凑', '标准', '宽松']}
                      onChange={(v) => set({ uiDensity: v })}
                      width={180}
                    />
                  }
                />
                <SettingRow
                  title="动画效果"
                  desc="启用界面过渡动画"
                  control={<Switch checked={settings.enableAnimations} onChange={(v) => set({ enableAnimations: v })} />}
                />
              </div>
            </div>
          )}

          {/* ══ 语言 ══ */}
          {activeSection === 'language' && (
            <div className="ds-settingrow__group">
              <div className="ds-settingrow__panel">
                <SettingRow
                  title="界面语言"
                  desc="应用界面的显示语言"
                  control={
                    <Select
                      value={settings.uiLanguage}
                      // N-2：i18n 字典尚未完整覆盖全界面，English 暂以禁用态呈现，避免选择后半成品误导
                      options={[
                        '简体中文',
                        { value: '繁体中文', label: '繁体中文（即将支持）', disabled: true },
                        { value: 'English', label: 'English（即将支持）', disabled: true },
                        { value: '日本語', label: '日本語（即将支持）', disabled: true }
                      ]}
                      onChange={(v) => set({ uiLanguage: v })}
                      width={180}
                    />
                  }
                />
                <SettingRow
                  title="日期格式"
                  desc="日期的显示格式"
                  control={
                    <Select
                      value={settings.dateFormat}
                      options={['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY']}
                      onChange={(v) => set({ dateFormat: v })}
                      width={180}
                    />
                  }
                />
                <SettingRow
                  title="评分制式"
                  desc="番剧评分的显示制式"
                  control={
                    <Select
                      value={settings.ratingSystem}
                      options={['10分制', '5星制', '百分制']}
                      onChange={(v) => set({ ratingSystem: v })}
                      width={180}
                    />
                  }
                />
              </div>
            </div>
          )}

          {/* ══ 局域网播放（F-4）══ */}
          {activeSection === 'webserve' && (
            <div className="ds-settingrow__group">
              <span className="ds-settingrow__grouplabel">局域网播放</span>
              <div className="ds-settingrow__panel">
                <SettingRow
                  title="启用局域网播放"
                  desc="在本机启动只读 HTTP 服务，局域网设备浏览器可直接观看媒体库视频"
                  control={<Switch checked={Boolean(settings.webServerEnabled)} onChange={(v) => toggleWebServer(v)} />}
                />
                <SettingRow
                  title="端口"
                  desc="HTTP 服务端口（被占用时自动顺延）"
                  control={
                    <div className="ds-input settings-number-input" style={{ width: 120 }}>
                      <input
                        type="number"
                        min="1"
                        max="65535"
                        value={settings.webServerPort}
                        disabled={Boolean(settings.webServerEnabled)}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          if (v >= 1 && v <= 65535) applyWebConfig({ port: v })
                        }}
                      />
                    </div>
                  }
                />
                <SettingRow
                  title="允许局域网访问"
                  desc="开启后绑定全部网卡（0.0.0.0），同局域网内设备可访问；关闭则仅本机可用"
                  control={<Switch checked={Boolean(settings.webServerBindAll)} onChange={(v) => applyWebConfig({ bindAll: v })} />}
                />
                {webInfo && webInfo.urls && webInfo.urls.length > 0 && (
                  <SettingRow
                    title="访问地址"
                    desc={`${webInfo.status || ''}${webInfo.videoCount ? ` · 共 ${webInfo.videoCount} 集` : ''}`}
                    control={
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%', maxWidth: 440 }}>
                        {webInfo.urls.map((u) => (
                          <a
                            key={u.url}
                            className="ds-input"
                            href={u.url}
                            target="_blank"
                            rel="noreferrer"
                            title={u.url}
                            style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}
                          >
                            {u.name} · {u.url}
                          </a>
                        ))}
                      </div>
                    }
                  />
                )}
                <SettingRow
                  title="重置访问令牌"
                  desc="旧地址立即失效（若服务运行中会自动重启使新令牌生效）"
                  control={<button className="ds-btn ds-btn--secondary" onClick={handleResetToken}>重置令牌</button>}
                />
                <p className="ds-settingrow__desc" style={{ color: 'var(--status-warning-default)' }}>
                  安全提示：令牌包含在访问地址中，请勿公开分享；拿到地址即可观看库内视频。
                </p>
              </div>
            </div>
          )}

          {/* ══ 数据管理 ══ */}
          {activeSection === 'data' && (
            <>
              <div className="ds-settingrow__group">
                <div className="ds-settingrow__panel">
                  <SettingRow
                    title="导出数据"
                    desc="将所有番剧数据和设置导出为 JSON 文件"
                    control={<button className="ds-btn ds-btn--secondary" onClick={handleExport}>导出数据</button>}
                  />
                  <SettingRow
                    title="导入数据"
                    desc="从 JSON 文件导入番剧数据和设置"
                    control={<button className="ds-btn ds-btn--secondary" onClick={handleImport}>导入数据</button>}
                  />
                  <SettingRow
                    title="重建数据库"
                    desc="重建番剧索引数据库，可能需要几分钟"
                    control={<button className="ds-btn ds-btn--secondary" onClick={handleRebuild}>重建数据库</button>}
                  />
                  <SettingRow
                    title="重置所有数据"
                    desc="删除所有数据和设置，恢复到初始状态"
                    control={
                      <button className="ds-btn settings-danger-btn" onClick={handleReset}>重置所有数据</button>
                    }
                  />
                </div>
              </div>

              <div className="ds-settingrow__group">
                <span className="ds-settingrow__grouplabel">同步与工具</span>
                <div className="ds-settingrow__panel">
                  {/* N5 骨架：AniList 双向同步（OAuth 配置 + 进度/状态同步） */}
                  <SettingRow
                    title="AniList 同步"
                    desc="登录后双向同步观看进度与追番状态（开发中）"
                    control={
                      <button className="ds-btn ds-btn--secondary" onClick={() => showToast('AniList 同步即将上线', 'warning')}>
                        连接 AniList
                      </button>
                    }
                  />
                  {/* N11 骨架：上传封面到远程 / 导出缩略图等工具 */}
                  <SettingRow
                    title="封面云上传"
                    desc="将本地封面缓存上传到图床，支持远程访问（开发中）"
                    control={
                      <button className="ds-btn ds-btn--secondary" onClick={() => showToast('封面云上传即将上线', 'warning')}>
                        上传封面
                      </button>
                    }
                  />
                </div>
              </div>
            </>
          )}

          {/* ══ 关于 ══ */}
          {activeSection === 'about' && (
            <div className="ds-settingrow__group">
              <div className="ds-settingrow__panel">
                <SettingRow
                  title="AnimeRepo 溯番"
                  desc="一款专为动漫爱好者设计的番剧管理工具"
                  control={<span className="ds-tag ds-tag--brand">v{version}</span>}
                />
                {updateSourceConfigured && (
                  <SettingRow
                    title="检查更新"
                    desc="检查是否有新版本可用"
                    control={
                      <button
                        className="ds-btn ds-btn--secondary"
                        onClick={async () => {
                          const res = await api.checkUpdate()
                          if (!res || !res.ok) {
                            showToast(res && res.reason === 'network' ? '检查更新失败（网络不可用）' : '更新源尚未配置（发布后启用）', 'info')
                          } else if (res.hasUpdate) {
                            showToast(`发现新版本 v${res.latest}（当前 v${res.current}）`, 'success', 6000)
                            if (res.url && res.url !== '#') window.electron?.shell?.openExternal?.(res.url)
                          } else {
                            showToast(`已是最新版本 v${res.current}`, 'success')
                          }
                        }}
                      >
                        检查更新
                      </button>
                    }
                  />
                )}
                <SettingRow
                  title="开源许可"
                  desc="查看本应用使用的开源组件及许可证"
                  control={
                    <button
                      className="ds-btn ds-btn--link"
                      onClick={async () => {
                        const opened = await api.openLicense()
                        showToast(opened ? '已打开许可文件' : '未找到 LICENSE 文件', opened ? 'success' : 'warning')
                      }}
                    >
                      查看许可
                    </button>
                  }
                />
              </div>
              <div className="settings-about-footer">
                <div>Made with ♥ for anime lovers</div>
                <div>© 2026 AnimeRepo 溯番. All rights reserved.</div>
              </div>
            </div>
          )}
        </div>

        {/* 底部操作条：设置即时生效，"取消"无意义，故只保留"完成"与"恢复默认" */}
        <div className="settings-footer">
          <button className="ds-btn ds-btn--link" onClick={handleRestoreDefaults}>恢复默认</button>
          <div className="settings-footer__actions">
            <button className="ds-btn ds-btn--brand" onClick={() => setActiveSection('library')}>完成</button>
          </div>
        </div>
      </div>

      {/* B-03：危险/重要操作确认对话框（替换原生 confirm） */}
      <ConfirmDialog
        open={rebuildConfirmOpen}
        title="重建数据库"
        description="确定要重建数据库吗？这可能需要几分钟时间。观看进度与评分会被保留。"
        confirmText="重建"
        onConfirm={confirmRebuild}
        onCancel={() => setRebuildConfirmOpen(false)}
      />
      <ConfirmDialog
        open={resetConfirmOpen}
        title="重置所有数据"
        description="确定要重置所有数据吗？此操作将删除所有番剧与设置，且无法恢复。"
        confirmText="全部删除"
        danger
        onConfirm={confirmReset}
        onCancel={() => setResetConfirmOpen(false)}
      />
      <ConfirmDialog
        open={defaultsConfirmOpen}
        title="恢复默认设置"
        description="确定要恢复为默认设置吗？当前设置将被覆盖（媒体库文件夹保留）。"
        confirmText="恢复默认"
        onConfirm={confirmRestoreDefaults}
        onCancel={() => setDefaultsConfirmOpen(false)}
      />
    </div>
  )
}