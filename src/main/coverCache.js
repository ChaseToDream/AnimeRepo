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

// 下载并缓存封面，返回本地 anime://cover URL；失败或非网络图返回原值
export async function cacheCover(coverUrl) {
  if (!coverUrl || /^anime:\/\//.test(coverUrl)) return coverUrl
  try {
    const dir = getCoverDir()
    fs.mkdirSync(dir, { recursive: true })
    const hash = crypto.createHash('md5').update(coverUrl).digest('hex')
    const extMatch = coverUrl.split('?')[0].match(COVER_EXTS)
    const ext = extMatch ? extMatch[0] : '.jpg'
    const file = join(dir, hash + ext)
    if (!fs.existsSync(file)) {
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
