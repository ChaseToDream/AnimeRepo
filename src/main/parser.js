// 文件名解析：从视频文件名中提取番剧名、季、集数与集标题
const EXT_RE = /\.[^.\/\\]+$/
const EP_PATTERNS = [
  // [Group] Title - 01  /  Title - EP01  /  Title - S01E02
  { re: /^(.*?)\s*[-—–]+\s*(?:EP|E|第)?\s*(\d{1,4})\s*$/i, season: null },
  // Title S01E02 / S1 E2
  { re: /^(.*?)\s*S(\d{1,2})\s*E(\d{1,4})$/i, season: 'capture' },
  // [Group] Title EP01 / 第01话 / 第X话
  { re: /^(.*?)\s*(?:第\s*)?(\d{1,4})\s*[话集话話]/i, season: null },
  // Title - EP 01 [1080p]
  { re: /^(.*?)\s*[-—–]?\s*(?:EP|Episode|E)\s*(\d{1,4})/i, season: null },
  // Title (2018) - Movie / 剧场版
  { re: /^(.*?)\s*[\[\]】】【]\s*(\d{1,4})\s*[话集]/i, season: null }
]

// 规范化标题 key，用于番剧分组与匹配
function titleKey(title) {
  return (title || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[\s\-_：:，,。.!！?？·【】\[\]()（）]+/g, '')
    .replace(/第.{1,6}[季期部]|season|s\d{1,2}e\d{1,4}/gi, '')
    .trim()
}

function stripExt(filename) {
  return filename.replace(EXT_RE, '')
}

function parseEpisodeNumber(text) {
  for (const p of EP_PATTERNS) {
    const m = (text || '').match(p.re)
    if (m) {
      let season = null
      let num = null
      if (p.season === 'capture') {
        season = parseInt(m[2], 10) || 1
        num = parseInt(m[3], 10)
      } else {
        // 从末尾捕获的纯数字序号，或 [第X话] 捕获
        num = parseInt(m[2], 10)
        if (Number.isNaN(num)) num = parseInt(m[2] || '', 10)
      }
      return { season, number: num }
    }
  }
  return null
}

// 初步拆分：尝试去除发布组/分辨率等噪声
function cleanTitlePart(raw) {
  return raw
    .replace(/\b(?:1080p|720p|2160p|4k|8k|HEVC|x264|x265|H\.264|H\.265|AVC|AV1|Hi10P|BDRip|BDMV|WEB-DL|WEBRip|HDR|DV|10bit|8bit)\b/gi, ' ')
    .replace(/[\[\]【】]/g, ' ')
    .replace(/版|中文字幕|简繁|[Aa]ss|[Ss]rt/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[-—–]+$/g, '')
    .trim()
}

// 主入口：解析视频文件名
function parseFilename(filename, folderName) {
  const base = stripExt(filename)
  let season = null
  let number = null
  let title = null
  let epTitle = null

  // S01Exx 结构
  const s01 = base.match(/^(.*?)\s*S(\d{1,2})\s*E(\d{1,4})/i)
  if (s01) {
    title = cleanTitlePart(s01[1]) || (folderName ? cleanTitlePart(folderName) : '')
    season = parseInt(s01[2], 10) || 1
    number = parseInt(s01[3], 10)
    const rest = base.slice(s01[0].length)
    if (rest && !/^[.[\-\s]*$/.test(rest)) epTitle = cleanTitlePart(rest)
  }

  // [第X话] 结构：Title 第01话 / Title - 第02话 EP标题
  if (!number) {
    const cn = base.match(/^(.*?)\s*[第]?\s*(\d{1,4})\s*[话话話][集]?\s*(.*)$/)
    if (cn && cn[2]) {
      title = cleanTitlePart(cn[1]) || (folderName ? cleanTitlePart(folderName) : '')
      number = parseInt(cn[2], 10)
      epTitle = cn[3] ? cleanTitlePart(cn[3]) : null
    }
  }

  // 通用 EP 前缀：Title - EP01 / Title EP01
  if (!number) {
    const ep = base.match(/^(.*?)\s*[-—–]?\s*(?:EP|Episode|E|第)?\s*(\d{1,4})\s*(.*)$/i)
    if (ep && ep[2] && ep[1].length > 0) {
      const maybeTitle = cleanTitlePart(ep[1])
      const maybeNum = parseInt(ep[2], 10)
      // 排除时间/其他纯数字误判：要求标题至少含一个非数字字符
      if (maybeTitle && /[^\d]/.test(maybeTitle)) {
        title = maybeTitle
        number = maybeNum
        epTitle = ep[3] ? cleanTitlePart(ep[3]) : null
      }
    }
  }

  // 无解析结果时，以文件名整体 + 序号为兜底
  if (!number) {
    const m = parseEpisodeNumber(filename)
    if (m) {
      number = m.number
      season = m.season
      title = cleanTitlePart(base) || (folderName ? cleanTitlePart(folderName) : '未知番剧')
    }
  }

  if (!title) title = (folderName ? cleanTitlePart(folderName) : cleanTitlePart(base)) || '未知番剧'
  if (!season) season = 1
  if (!number) number = 0

  return {
    animeTitle: title,
    titleKey: titleKey(title),
    season,
    number,
    epTitle: epTitle || (number > 0 ? `第 ${number} 话` : filename)
  }
}

// B8：按自定义正则解析文件名（recognizeMode = 正则表达式 时使用）
// 约定：最后一个数值捕获组为集数，其余捕获组拼接为标题；
// 解析失败或正则非法时返回 null，由调用方回退到默认启发式解析。
export function parseWithRegex(filename, pattern) {
  try {
    const re = new RegExp(pattern)
    const m = (filename || '').match(re)
    if (!m || m.length < 2) return null
    const groups = m.slice(1)
    const num = parseInt(groups[groups.length - 1], 10)
    if (Number.isNaN(num)) return null
    const title = groups.slice(0, -1).filter(Boolean).join(' ').trim() || '未知番剧'
    return {
      animeTitle: title,
      titleKey: titleKey(title),
      season: 1,
      number: num,
      epTitle: `第 ${num} 话`
    }
  } catch (e) {
    return null
  }
}

export { parseFilename, titleKey, cleanTitlePart }