// i18n 基础设施（N7 骨架）：字典 + 翻译函数，由 uiLanguage 设置驱动
// 当前覆盖导航与状态栏高频文案；其余文案为渐进迁移（暂保留中文硬编码）
const messages = {
  'zh-CN': {
    'nav.search': '搜索番剧...',
    'nav.myGroup': '我的番剧',
    'nav.all': '全部番剧',
    'nav.watching': '正在观看',
    'nav.completed': '已完成',
    'nav.plan': '想看',
    'nav.onhold': '搁置',
    'nav.browse': '浏览',
    'nav.stats': '统计面板',
    'nav.recent': '最近观看',
    'nav.category': '分类',
    'nav.emptyGenres': '扫描后可生成分类',
    'nav.media': '媒体库',
    'nav.settings': '设置',
    'status.scanning': '正在扫描…',
    'status.found': '正在扫描… 已发现 {n} 个文件',
    'status.metadata': '正在获取元数据 {c}/{t}',
    'status.settings': '设置',
    'status.stats': '统计面板',
    'status.library': '番剧库',
    'status.autoSync': '自动同步已开启',
    'status.autoSyncOff': '自动同步已关闭',
    'status.count': '{n} 部番剧 · {e} 集',
    'status.libraries': '已用 {n} 个媒体库'
  },
  'en-US': {
    'nav.search': 'Search anime...',
    'nav.myGroup': 'My Anime',
    'nav.all': 'All',
    'nav.watching': 'Watching',
    'nav.completed': 'Completed',
    'nav.plan': 'Plan to Watch',
    'nav.onhold': 'On Hold',
    'nav.browse': 'Browse',
    'nav.stats': 'Stats',
    'nav.recent': 'Recently Watched',
    'nav.category': 'Genres',
    'nav.emptyGenres': 'Genres appear after scan',
    'nav.media': 'Library',
    'nav.settings': 'Settings',
    'status.scanning': 'Scanning…',
    'status.found': 'Scanning… {n} files found',
    'status.metadata': 'Fetching metadata {c}/{t}',
    'status.settings': 'Settings',
    'status.stats': 'Stats',
    'status.library': 'Library',
    'status.autoSync': 'Auto-sync on',
    'status.autoSyncOff': 'Auto-sync off',
    'status.count': '{n} anime · {e} episodes',
    'status.libraries': '{n} libraries'
  }
}

const LOCALE_MAP = {
  简体中文: 'zh-CN',
  繁体中文: 'zh-TW',
  English: 'en-US',
  日本語: 'ja-JP'
}

const FALLBACK = 'zh-CN'

export function resolveLocale(code) {
  return LOCALE_MAP[code] || FALLBACK
}

// 创建翻译函数：t(key, vars?)；字典缺失时回退中文，再缺返回 key 本身
export function createTranslator(code) {
  const dict = messages[resolveLocale(code)] || messages[FALLBACK]
  return (key, vars) => {
    let str = dict[key] || messages[FALLBACK][key] || key
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replace(`{${k}}`, String(v))
      }
    }
    return str
  }
}
