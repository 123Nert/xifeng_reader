/**
 * encoding.ts — TXT 编码探测与解码（纯函数，零依赖）。
 *
 * 探测按序执行（技术方案 §3.1）：
 * 1. BOM 检查：EF BB BF → UTF-8；FF FE / FE FF → UTF-16LE/BE（低频但零成本）；
 * 2. 无 BOM：用 TextDecoder('utf-8', { fatal: true }) 严格解码，成功即判定 UTF-8；
 * 3. 严格解码抛错 → 回退 GB18030。GBK 是 GB18030 的子集，取超集不会丢字；
 * 4. 仍失败（环境不支持等）：非严格 UTF-8 兜底，保证永不抛异常。
 */

export interface DecodeResult {
  text: string
  charset: string
}

export interface DecodeOptions {
  /** 强制使用的编码标签（如 'gb18030'、'big5'）；'auto' 或缺省走自动探测。 */
  charset?: string
}

export function decodeText(buffer: ArrayBuffer | Uint8Array, options?: DecodeOptions): DecodeResult {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)

  // 手动指定编码（V1.3 兜底自动探测的少数场景）；解码失败则回退自动探测
  const forced = options?.charset
  if (forced && forced !== 'auto') {
    try {
      return { text: new TextDecoder(forced).decode(bytes), charset: forced }
    } catch {
      // 标签无效或字节非法，继续走自动探测
    }
  }

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), charset: 'utf-8' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), charset: 'utf-16le' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), charset: 'utf-16be' }
  }

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), charset: 'utf-8' }
  } catch {
    // 不是合法 UTF-8，继续尝试 GB18030
  }
  try {
    return { text: new TextDecoder('gb18030').decode(bytes), charset: 'gb18030' }
  } catch {
    // 环境不支持 GB18030 或字节非法，走兜底
  }
  return { text: new TextDecoder('utf-8').decode(bytes), charset: 'utf-8' }
}
