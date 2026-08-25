// 文本编码探测解码（B-2 / V3-3 共用）：桌面字幕（ipc.js）与局域网页字幕（webServer.js）
// 使用同一套策略，保证两侧对 GBK/GB18030、UTF-16、UTF-8 的解析一致。
// 1) BOM 判定：UTF-16 LE/BE、UTF-8 BOM 直接按对应编码解码；
// 2) 无 BOM：先尝试严格 UTF-8（fatal），成功即用（兼容纯 ASCII 与合法 UTF-8）；
// 3) 严格 UTF-8 失败：回退 GB18030（GBK 超集，任意字节序列均可解码，不会抛错）。
export function decodeTextBuffer(buf) {
  if (!buf || !buf.length) return ''
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
    if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch (e) {
    // 非纯 UTF-8：按简体中文环境最常见的 GB18030 解码
    return new TextDecoder('gb18030').decode(buf)
  }
}