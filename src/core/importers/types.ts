/**
 * types.ts — 统一导入管线的类型（V5.0）。
 */

export const BOOK_FORMATS = ['txt', 'epub', 'md', 'html'] as const
export type BookFormat = (typeof BOOK_FORMATS)[number]

export const FORMAT_LABELS: Record<BookFormat, string> = {
  txt: 'TXT',
  epub: 'EPUB',
  md: 'MD',
  html: 'HTML',
}

export interface TocEntryLite {
  title: string
  charIndex: number
}

/** 导入结果：所有格式归一为「单文本流 + 目录 + 元信息」。 */
export interface ImportResult {
  title: string
  text: string
  format: BookFormat
  /** TXT 专有：探测到的编码 */
  charset?: string
  /** 封面 data URL（EPUB 提取） */
  cover?: string
  /** 真实目录（EPUB/HTML/MD）；缺省时阅读页回退正则切分 */
  tocEntries?: TocEntryLite[]
  author?: string
  language?: string
  /** 局部失败报告（如某章解析失败），供 UI 提示 */
  warnings: string[]
}

export class ImportError extends Error {
  constructor(
    message: string,
    /** 面向用户的下一步建议 */
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'ImportError'
  }
}

/** 导入进度回调（大文件解析时驱动 UI）。 */
export type ImportProgress = (info: { phase: string; current?: number; total?: number }) => void
