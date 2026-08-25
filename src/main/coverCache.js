// 封面本地缓存：把网络封面下载到 userData/covers 目录，
// 并通过 anime://cover/<base64文件名> 本地读取，离线可用且避免重复网络请求
import { app } from 'electron'
import { join } from 'path'
import fs from 'fs'
import crypto from 'crypto'

const COVER_EXTS = /\.(jpg|jpeg|png|webp|gif)$/i

// 封面缓存目录（按需创建）
export function getCoverDir() {
  return join(app.getPath('userData'), 'covers')
}

// P5：目录创建结果缓存——原先每个新番剧封面都执行一次 mkdirSync + existsSync，
// 大库首扫时高频同步 I/O 阻塞主进程；改为进程内只创建一次，其余调用直接复用
let coverDirReady = null

// 下载并缓存封面，返回本地 anime://cover URL；失败或非网络图返回原值
export async function cacheCover(coverUrl) {
  if (!coverUrl || /^anime:\/\//.test(coverUrl)) return coverUrl
  try {
    const dir = getCoverDir()
    if (!coverDirReady) {
      coverDirReady = fs.promises.mkdir(dir, { recursive: true }).catch(() => {})
    }
    await coverDirReady
    const hash = crypto.createHash('md5').update(coverUrl).digest('hex')
    const extMatch = coverUrl.split('?')[0].match(COVER_EXTS)
    const ext = extMatch ? extMatch[0] : '.jpg'
    const file = join(dir, hash + ext)
    let cached = false
    try {
      await fs.promises.access(file)
      cached = true
    } catch {
      cached = false
    }
    if (!cached) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)
      let res
      try {
        res = await fetch(coverUrl, { signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      if (!res || !res.ok) return coverUrl
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) return coverUrl
      // 异步写盘，避免大库首扫时同步写阻塞主进程
      await fs.promises.writeFile(file, buf)
    }
    return 'anime://cover/' + Buffer.from(hash + ext, 'utf-8').toString('base64url')
  } catch (e) {
    return coverUrl
  }
}

// N-06：把用户选择的本地图片复制进封面缓存目录，返回 anime://cover URL
// 文件名用「源路径 + 大小 + mtime」哈希——同一文件重复选择命中缓存，
// 源文件更新后（size/mtime 变化）生成新名称避免旧缓存干扰
export async function saveLocalCover(srcPath) {
  try {
    if (!srcPath) return ''
    const dir = getCoverDir()
    if (!coverDirReady) {
      coverDirReady = fs.promises.mkdir(dir, { recursive: true }).catch(() => {})
    }
    await coverDirReady
    const stat = await fs.promises.stat(srcPath)
    const hash = crypto
      .createHash('md5')
      .update(`${srcPath}|${stat.size}|${stat.mtimeMs}`)
      .digest('hex')
    const extMatch = srcPath.split('?')[0].match(COVER_EXTS)
    const ext = extMatch ? extMatch[0] : '.jpg'
    const file = join(dir, hash + ext)
    let cached = false
    try {
      await fs.promises.access(file)
      cached = true
    } catch {
      cached = false
    }
    if (!cached) {
      await fs.promises.copyFile(srcPath, file)
    }
    return 'anime://cover/' + Buffer.from(hash + ext, 'utf-8').toString('base64url')
  } catch (e) {
    return ''
  }
}

// B-5 修复：清理未被引用的本地封面——covers 目录随换源/改封面无限增长，
// 磁盘上会残留大量不再被任何番剧引用的历史 hash 文件。
// 调用方传入当前媒体库仍「引用的缓存文件名」集合（由 anime://cover/<base64> 解码得到），
// 删除不在此集合内的封面文件。删除失败静默忽略，不阻塞启动。
export async function cleanupUnusedCovers(referencedFileNames) {
  try {
    const dir = getCoverDir()
    let entries
    try {
      entries = await fs.promises.readdir(dir)
    } catch (e) {
      return // 目录不存在/不可读：无需清理
    }
    if (!entries.length) return
    const keep = new Set(Array.isArray(referencedFileNames) ? referencedFileNames : [])
    const candidates = entries.filter((n) => COVER_EXTS.test(n) && !keep.has(n))
    await Promise.all(candidates.map((n) => fs.promises.unlink(join(dir, n)).catch(() => {})))
  } catch (e) {
    /* 清理失败不影响启动 */
  }
}
