// F-4 局域网播放：只读 HTTP 流服务
// 让用户用局域网内其他设备（手机/平板/电视）的浏览器直接观看媒体库视频。
// 安全边界（与 anime:// 协议同款）：
//  1) 访问必须携带一次性令牌（URL 形如 /play/<token>、/stream/<token>/<base64>）；
//  2) 只允许读取「媒体库文件夹内」且为受支持扩展名的视频文件；
//  3) 默认仅监听 127.0.0.1（本机），开启「允许局域网访问」才绑定 0.0.0.0；
//  4) 支持 Range 请求与断点续传，浏览器 <video> 可正常拖动进度条。
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolve, sep } from 'path'
import crypto from 'crypto'
import { getSettings, updateSettings, list } from './store'

const VIDEO_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.rmvb': 'application/vnd.rn-realmedia-vbr',
  '.rm': 'application/vnd.rn-realmedia'
}
// 与 settings.videoFormats 白名单保持一致（无配置时回退内置扩展名）
const FALLBACK_VIDEO_EXT = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|rmvb|rm)$/i

let server = null
let currentToken = ''

function escapeRe(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function genToken() {
  return crypto.randomBytes(18).toString('base64url')
}

// 确保令牌已生成并持久化（重启后访问地址不变），异常时不抛出
function ensureToken() {
  const saved = getSettings().webServerToken
  if (saved && typeof saved === 'string' && saved.length >= 16) {
    currentToken = saved
    return saved
  }
  currentToken = genToken()
  try {
    updateSettings({ webServerToken: currentToken })
  } catch (e) {
    /* 令牌存储失败：本次会话仍可用 */
  }
  return currentToken
}

export function resetToken() {
  currentToken = genToken()
  try {
    updateSettings({ webServerToken: currentToken })
  } catch (e) {
    /* ignore */
  }
  return currentToken
}

// 校验：文件位于媒体库文件夹内，且扩展名受支持（与 B7 anime:// 协议同一安全边界）
function isAllowedVideo(filePath) {
  try {
    if (!filePath) return false
    const settings = getSettings()
    const folders = settings.libraryFolders || []
    if (!folders.length) return false
    const resolved = resolve(filePath)
    const inFolder = folders.some((f) => {
      const base = resolve(f)
      return resolved === base || resolved.startsWith(base + sep)
    })
    if (!inFolder) return false
    const formats = (settings.videoFormats || []).filter(Boolean)
    if (formats.length) {
      const re = new RegExp(`\\.(${formats.map(escapeRe).join('|')})$`, 'i')
      return re.test(filePath)
    }
    return FALLBACK_VIDEO_EXT.test(filePath)
  } catch (e) {
    return false
  }
}

function b64decode(s) {
  try {
    return Buffer.from(String(s || ''), 'base64url').toString('utf-8')
  } catch (e) {
    return ''
  }
}

// 局域网 IPv4 地址列表（用于展示访问地址）
function lanAddresses() {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface && !iface.internal && iface.family === 'IPv4' && iface.address) out.push(iface.address)
    }
  }
  return out
}

export function getWebInfo() {
  const settings = getSettings()
  ensureToken()
  const addr = server ? server.address() : null
  const statusMap = {
    blocked: '端口被占用',
    listening: '运行中',
    closed: '已关闭',
    error: '启动失败'
  }
  const status = server === false ? 'error' : server ? 'listening' : 'closed'
  // 实际监听端口（端口冲突自动顺延后与配置值可能不同；服务未运行时显示配置端口）
  const actualPort = addr && typeof addr === 'object' ? addr.port : settings.webServerPort
  const urls = []
  const base = (host) => `http://${host}:${actualPort}`
  urls.push({ name: '本机', url: `${base('127.0.0.1')}/play/${currentToken}` })
  if (settings.webServerBindAll) {
    for (const ip of lanAddresses()) {
      urls.push({ name: ip, url: `${base(ip)}/play/${currentToken}` })
    }
  }
  return {
    enabled: Boolean(settings.webServerEnabled),
    status: server === true ? statusMap.listening : statusMap[status],
    port: actualPort,
    urls,
    bindAll: Boolean(settings.webServerBindAll),
    videoCount: list().reduce((n, a) => n + (a.episodes || []).length, 0)
  }
}

// —— 静态页面 ——
// 收集全部可播放视频条目（可按标题过滤）
function buildItems(filter) {
  const items = []
  const q = String(filter || '').trim().toLowerCase()
  for (const a of list()) {
    const title = a.title || ''
    for (const e of a.episodes || []) {
      if (!e.filePath) continue
      if (q && !title.toLowerCase().includes(q)) continue
      items.push({ t: title, n: e.number, f: e.filePath })
    }
  }
  return items
}

// P-12：列表页首屏内嵌的条目上限（超大型媒体库防传输与 DOM 膨胀）；搜索接口同上限
const LIST_PAGE_MAX = 500

// 列表页：媒体库视频列表（含 token 的 URL 才能打开；首屏前 500，搜索走 /list 接口）
function indexHtml(token) {
  const all = buildItems()
  const total = all.length
  const shown = all.slice(0, LIST_PAGE_MAX)
  const initJson = JSON.stringify({ total, shown }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AnimeRepo · 局域网播放</title>
<style>
  body{background:#0d0d12;color:#e8e8ea;font-family:system-ui,"Microsoft YaHei",sans-serif;margin:0;padding:16px}
  h1{font-size:18px;margin:4px 0 12px}
  input{width:100%;max-width:420px;box-sizing:border-box;padding:8px 12px;border-radius:8px;border:1px solid #2a2b31;background:#121318;color:#e8e8ea;font-size:14px;margin-bottom:10px}
  .info{color:#9aa0a6;font-size:12px;margin-bottom:12px}
  ul{list-style:none;padding:0;margin:0}
  li{padding:8px 10px;border-radius:8px;cursor:pointer}
  li:hover{background:#1c1d22}
  li .t{font-size:14px}
  li .m{color:#9aa0a6;font-size:12px;margin-top:2px}
</style>
</head>
<body>
<h1>AnimeRepo 局域网播放</h1>
<input id="q" type="search" placeholder="搜索番剧…" autocomplete="off" />
<div class="info" id="info"></div>
<ul id="list"></ul>
<script>
(function(){
  const INIT = ${initJson};
  const TOK = ${JSON.stringify(token)};
  function b64u(s){return btoa(String.fromCharCode.apply(null,new Uint8Array(new TextEncoder().encode(s)))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/g,'')}
  function render(items){
    const ul = document.getElementById('list');
    ul.innerHTML = '';
    (items || []).forEach(function(it){
      const li = document.createElement('li');
      const t = document.createElement('div'); t.className = 't';
      t.textContent = (it.n > 0 ? '#' + String(it.n).padStart(2,'0') + ' ' : '') + it.t;
      const m = document.createElement('div'); m.className = 'm';
      m.textContent = (it.f || '').split(/[\\\\/]/).pop();
      li.appendChild(t); li.appendChild(m);
      li.addEventListener('click', function(){ window.open('/page/' + TOK + '/' + b64u(it.f), '_blank'); });
      ul.appendChild(li);
    });
  }
  function apply(kw){
    const info = document.getElementById('info');
    if (!kw) {
      info.textContent = '共 ' + INIT.total + ' 集 · 点击开始播放' + (INIT.total > INIT.shown.length ? '（仅显示前 ' + INIT.shown.length + ' 条）' : '');
      render(INIT.shown);
      return;
    }
    fetch('/list/' + TOK + '?q=' + encodeURIComponent(kw))
      .then(function(r){ return r.json(); })
      .then(function(d){
        info.textContent = '匹配 ' + d.total + ' 集' + (d.total > d.items.length ? '（仅显示前 ' + d.items.length + ' 条）' : '');
        render(d.items || []);
      })
      .catch(function(){});
  }
  document.getElementById('q').addEventListener('input', function(e){ apply(e.target.value); });
  apply('');
})();
</script>
</body>
</html>`
}

// 单集播放页
function playerHtml(token, filePath) {
  const name = path.basename(filePath)
  const b64 = Buffer.from(filePath, 'utf-8').toString('base64url')
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${String(name).replace(/</g, '&lt;')}</title>
<style>
  html,body{margin:0;background:#000}
  video{width:100vw;height:100vh;display:block;background:#000}
</style>
</head>
<body>
<video controls autoplay src="/stream/${token}/${b64}"></video>
</body>
</html>`
}

function sendText(res, code, body, type = 'text/html; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type })
  res.end(body)
}

function serveVideo(req, res, filePath) {
  if (!isAllowedVideo(filePath)) {
    sendText(res, 403, 'forbidden', 'text/plain; charset=utf-8')
    return
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendText(res, 404, 'not found', 'text/plain; charset=utf-8')
      return
    }
    const mime = VIDEO_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
    const size = stat.size
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', mime)
    const range = req.headers.range
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(String(range))
      let start = m && m[1] !== '' ? parseInt(m[1], 10) : 0
      let end = m && m[2] !== '' ? parseInt(m[2], 10) : size - 1
      if (!Number.isFinite(start) || start < 0) start = 0
      if (!Number.isFinite(end) || end >= size) end = size - 1
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` })
        res.end()
        return
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1
      })
      fs.createReadStream(filePath, { start, end }).pipe(res)
    } else {
      res.writeHead(200, { 'Content-Length': size })
      fs.createReadStream(filePath).pipe(res)
    }
  })
}

function handleRequest(req, res) {
  // 仅 GET / HEAD
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'method not allowed', 'text/plain')
    return
  }
  let url
  try {
    url = new URL(req.url, 'http://localhost')
  } catch (e) {
    sendText(res, 400, 'bad request', 'text/plain')
    return
  }
  const seg = url.pathname.split('/').filter(Boolean)
  // seg = [kind, token, ...]  kind ∈ play | page | stream
  if (seg.length < 2 || seg[1] !== currentToken) {
    sendText(res, 401, 'unauthorized', 'text/plain')
    return
  }
  const kind = seg[0]
  const token = seg[1]
  if (kind === 'play' && seg.length === 2) {
    sendText(res, 200, indexHtml(token))
    return
  }
  // P-12：搜索接口（标题模糊匹配，JSON 返回，上限 LIST_PAGE_MAX）
  if (kind === 'list' && seg.length === 2) {
    const q = url.searchParams.get('q') || ''
    const matched = buildItems(q)
    const payload = JSON.stringify({ total: matched.length, items: matched.slice(0, LIST_PAGE_MAX) }).replace(/</g, '\\u003c')
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(payload)
    return
  }
  if (kind === 'page' && seg.length === 3) {
    const filePath = b64decode(seg[2])
    if (!isAllowedVideo(filePath)) {
      sendText(res, 403, 'forbidden', 'text/plain')
      return
    }
    sendText(res, 200, playerHtml(token, filePath))
    return
  }
  if (kind === 'stream' && seg.length === 3) {
    const filePath = b64decode(seg[2])
    serveVideo(req, res, filePath)
    return
  }
  sendText(res, 404, 'not found', 'text/plain')
}

// 启动服务：端口被占用时自动 +1 重试（最多 10 次）
export async function startWebServer() {
  stopWebServer()
  ensureToken()
  const settings = getSettings()
  const host = settings.webServerBindAll ? '0.0.0.0' : '127.0.0.1'
  let port = settings.webServerPort || 39282
  for (let i = 0; i < 10; i++) {
    await new Promise((resolveListen) => {
      const srv = http.createServer(handleRequest)
      srv.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE') resolveListen(false)
        else resolveListen(false)
      })
      srv.listen(port, host, () => {
        server = srv
        resolveListen(true)
      })
    })
    if (server) return true
    port += 1
  }
  server = false
  return false
}

export function stopWebServer() {
  if (server && typeof server.close === 'function') {
    try { server.close() } catch (e) { /* ignore */ }
  }
  server = null
}