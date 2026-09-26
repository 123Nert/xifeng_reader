/**
 * index.ts — 统一导入入口（V5.0）。
 *
 * 探测顺序：魔数（ZIP→EPUB / %PDF→明确不支持）→ 扩展名 → 内容特征（HTML）→ TXT 兜底。
 * 所有失败都以 ImportError 抛出，带中文原因与下一步建议。
 */
import { decodeText } from '../encoding'
import { htmlToText } from './html'
import { parseMarkdown } from './markdown'
import { importEpub } from './epub'
import { ImportError, type BookFormat, type ImportProgress, type ImportResult } from './types'

export type { BookFormat, ImportResult, TocEntryLite } from './types'
export { ImportError, BOOK_FORMATS, FORMAT_LABELS } from './types'
export { FORMAT_LABELS as FORMAT_BADGES } from './types'

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
const ZIP_MAGIC_EMPTY = [0x50, 0x4b, 0x05, 0x06]
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] // %PDF
const MOBI_MAGIC = [0x42, 0x4f, 0x4f, 0x4b] // BOOK (PalmDB)

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false
  return magic.every((b, i) => bytes[i] === b)
}

function extOf(fileName: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(fileName)
  return m ? m[1].toLowerCase() : ''
}

/** 按魔数与扩展名探测格式；返回 null 表示回落 TXT。 */
export function detectFormat(fileName: string, bytes: Uint8Array): BookFormat {
  const ext = extOf(fileName)
  if (startsWith(bytes, ZIP_MAGIC) || startsWith(bytes, ZIP_MAGIC_EMPTY)) return 'epub'
  if (ext === 'epub') return 'epub'
  if (ext === 'md' || ext === 'markdown') return 'md'
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return 'html'
  return 'txt'
}

/** 对明确不支持的格式给出针对性提示。 */
function assertSupported(fileName: string, bytes: Uint8Array): void {
  const ext = extOf(fileName)
  if (startsWith(bytes, PDF_MAGIC) || ext === 'pdf') {
    throw new ImportError(
      '暂不支持 PDF',
      'PDF 的文本抽取依赖复杂排版解析，本阅读器坚持零依赖实现；建议先用工具转成 EPUB 或 TXT',
    )
  }
  if (startsWith(bytes, MOBI_MAGIC) || ext === 'mobi' || ext === 'azw' || ext === 'azw3') {
    throw new ImportError(
      '暂不支持 MOBI / AZW3',
      '这是亚马逊私有格式；建议用 Calibre 转换为 EPUB 后再导入',
    )
  }
  if (ext === 'doc' || ext === 'docx') {
    throw new ImportError('暂不支持 Word 文档', '建议先另存为 TXT 或 Markdown 后再导入')
  }
}

/**
 * 导入一个文件为统一结果。
 * @param fallbackTitle 文件名（去扩展名），作为书名兜底
 */
export async function importBook(
  fileName: string,
  buffer: ArrayBuffer,
  onProgress?: ImportProgress,
): Promise<ImportResult> {
  const bytes = new Uint8Array(buffer)
  assertSupported(fileName, bytes)
  const format = detectFormat(fileName, bytes)
  const fallbackTitle = fileName.replace(/\.[^.]+$/, '') || '未命名'

  if (format === 'epub') {
    return await importEpub(buffer, fallbackTitle, onProgress)
  }

  if (format === 'html') {
    onProgress?.({ phase: '解析 HTML' })
    const { text: decoded } = decodeText(buffer)
    const { text, headings, docTitle } = htmlToText(decoded)
    if (!text) throw new ImportError('HTML 里没有可读的正文内容')
    return finishPlain(text, 'html', docTitle ?? fallbackTitle, headings)
  }

  if (format === 'md') {
    onProgress?.({ phase: '解析 Markdown' })
    const { text: decoded, charset } = decodeText(buffer)
    const md = parseMarkdown(decoded)
    if (!md.text) throw new ImportError('Markdown 里没有可读的正文内容')
    const r = finishPlain(md.text, 'md', md.title ?? fallbackTitle, md.headings)
    r.charset = charset
    // Markdown 用解析得到的精确偏移覆盖（标题已在文本流中）
    r.tocEntries = md.tocEntries
    return r
  }

  // TXT
  onProgress?.({ phase: '识别编码' })
  const { text, charset } = decodeText(buffer)
  if (!text.trim()) throw new ImportError('文件内容为空')
  return { title: fallbackTitle, text, format: 'txt', charset, warnings: [] }
}

/** HTML 的目录偏移：标题文本按出现顺序在正文中定位。 */
function finishPlain(
  text: string,
  format: BookFormat,
  title: string,
  headings: string[],
): ImportResult {
  const tocEntries: Array<{ title: string; charIndex: number }> = []
  let from = 0
  for (const h of headings) {
    const idx = text.indexOf(h, from)
    if (idx < 0) continue
    tocEntries.push({ title: h, charIndex: idx })
    from = idx + h.length
  }
  return {
    title,
    text,
    format,
    tocEntries: tocEntries.length > 0 ? tocEntries : undefined,
    warnings: [],
  }
}
