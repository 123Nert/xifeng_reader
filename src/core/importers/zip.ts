/**
 * zip.ts — 零依赖 ZIP 读取器（V5.0，EPUB 解析地基）。
 *
 * 只实现读：从文件尾定位 EOCD → 遍历中央目录 → 按需解压单个条目。
 * 压缩方式 8（deflate）用浏览器/Node 内置的 DecompressionStream('deflate-raw')。
 * 支持 ZIP64 尺寸/偏移扩展；不支持加密条目（明确报错）。
 */

const SIG_EOCD = 0x06054b50
const SIG_EOCD64_LOCATOR = 0x07064b50
const SIG_EOCD64 = 0x06064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

export interface ZipEntry {
  /** 归档内路径（已规范化为 / 分隔） */
  name: string
  /** 压缩方式：0 = 存储，8 = deflate */
  method: number
  compressedSize: number
  uncompressedSize: number
  /** 本地文件头偏移 */
  localOffset: number
  /** 加密标记 */
  encrypted: boolean
}

export class ZipError extends Error {}

function u16(dv: DataView, off: number): number {
  return dv.getUint16(off, true)
}
function u32(dv: DataView, off: number): number {
  return dv.getUint32(off, true)
}
function u64(dv: DataView, off: number): number {
  const lo = dv.getUint32(off, true)
  const hi = dv.getUint32(off + 4, true)
  const v = hi * 0x100000000 + lo
  return v
}

/** 从文件尾向前找 EOCD（最多回扫 64KB + 22，容忍注释）。 */
function findEocd(dv: DataView): number {
  const len = dv.byteLength
  const start = Math.max(0, len - 0xffff - 22)
  for (let i = len - 22; i >= start; i--) {
    if (u32(dv, i) === SIG_EOCD) return i
  }
  throw new ZipError('不是有效的 ZIP/EPUB 文件（未找到归档尾标记）')
}

export function readZipDirectory(buffer: ArrayBuffer): ZipEntry[] {
  const dv = new DataView(buffer)
  if (buffer.byteLength < 22) throw new ZipError('文件过小，不是有效的 ZIP/EPUB')

  const eocd = findEocd(dv)
  let entryCount = u16(dv, eocd + 10)
  let cdOffset = u32(dv, eocd + 16)

  // ZIP64：EOCD 字段为哨兵值时改用 ZIP64 EOCD
  if (entryCount === 0xffff || cdOffset === 0xffffffff) {
    const locatorOff = eocd - 20
    const isZip64 =
      locatorOff >= 0 && u32(dv, locatorOff) === SIG_EOCD64_LOCATOR
    if (isZip64) {
      const z64off = u64(dv, locatorOff + 8)
      if (z64off + 56 <= buffer.byteLength && u32(dv, z64off) === SIG_EOCD64) {
        entryCount = u64(dv, z64off + 32)
        cdOffset = u64(dv, z64off + 48)
      }
    }
  }

  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > buffer.byteLength || u32(dv, p) !== SIG_CENTRAL) break
    const method = u16(dv, p + 10)
    const flags = u16(dv, p + 8)
    let compressedSize = u32(dv, p + 20)
    let uncompressedSize = u32(dv, p + 24)
    const nameLen = u16(dv, p + 28)
    const extraLen = u16(dv, p + 30)
    const commentLen = u16(dv, p + 32)
    let localOffset = u32(dv, p + 42)
    const nameBytes = new Uint8Array(buffer, p + 46, nameLen)
    const name = new TextDecoder('utf-8').decode(nameBytes)

    // ZIP64 extra 字段：补齐哨兵值字段
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + nameLen
      const eEnd = e + extraLen
      while (e + 4 <= eEnd) {
        const tag = u16(dv, e)
        const size = u16(dv, e + 2)
        if (tag === 0x0001) {
          let q = e + 4
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = u64(dv, q)
            q += 8
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = u64(dv, q)
            q += 8
          }
          if (localOffset === 0xffffffff) {
            localOffset = u64(dv, q)
            q += 8
          }
          break
        }
        e += 4 + size
      }
    }

    entries.push({
      name: name.replace(/\\/g, '/'),
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
      encrypted: (flags & 0x1) !== 0,
    })
    p += 46 + nameLen + extraLen + commentLen
  }

  if (entries.length === 0) throw new ZipError('ZIP 归档为空或目录损坏')
  return entries
}

/** 解压单个条目的字节内容。 */
export async function readZipEntry(buffer: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.encrypted) throw new ZipError(`条目已加密，无法读取：${entry.name}`)
  const dv = new DataView(buffer)
  const p = entry.localOffset
  if (p + 30 > buffer.byteLength || u32(dv, p) !== SIG_LOCAL) {
    throw new ZipError(`本地文件头损坏：${entry.name}`)
  }
  const nameLen = u16(dv, p + 26)
  const extraLen = u16(dv, p + 28)
  const dataStart = p + 30 + nameLen + extraLen
  // 数据描述符（bit 3）场景下本地头 size 为 0，统一以中央目录的 compressedSize 为准
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > buffer.byteLength) throw new ZipError(`条目数据越界：${entry.name}`)

  const raw = new Uint8Array(buffer, dataStart, entry.compressedSize)
  if (entry.method === 0) return raw.slice()
  if (entry.method !== 8) throw new ZipError(`不支持的压缩方式（${entry.method}）：${entry.name}`)

  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const out = await new Response(stream).arrayBuffer()
  return new Uint8Array(out)
}

/** 便捷：按路径取文本（供 container.xml / OPF / XHTML 使用）。 */
export async function readZipText(
  buffer: ArrayBuffer,
  entries: ZipEntry[],
  name: string,
): Promise<string | null> {
  const entry = entries.find((e) => e.name === name || e.name === './' + name)
  if (!entry) return null
  const bytes = await readZipEntry(buffer, entry)
  return new TextDecoder('utf-8').decode(bytes)
}
