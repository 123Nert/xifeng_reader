/**
 * types.ts — 统一导入管线的类型（V5.0）。
 */

export const BOOK_FORMATS = ['txt', 'epub', 'md', 'html', 'pdf'] as const
export type BookFormat = (typeof BOOK_FORMATS)[number]

export const FORMAT_LABELS: Record<BookFormat, string> = {
  txt: 'TXT',
  epub: 'EPUB',
  md: 'MD',
  html: 'HTML',
  pdf: 'PDF',
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
  /**
   * V6.2 PDF：原版页面位图（每页一张，dataURL）。与 `text` 并存 ——
   * 阅读页默认按位图显示"原来的样子"（版式、图片、表格都在），
   * 抽出的文字用于搜索 / 划线 / 朗读 / 分页续读。
   * 位图只在浏览器侧产出（需要 DOM canvas）；Node 测试环境为 undefined。
   */
  pdfPages?: Array<{ dataUrl: string; width: number; height: number }>
  /**
   * V6.2 PDF：第 i 页文字在 `text` 中的起始偏移（0-based 页号）。
   * 页号 ↔ 字符偏移的换算见 core/pdfNav.ts；缺省表示没有对应表。
   */
  pdfPageStarts?: number[]
  /**
   * V6.2 PDF：是否存在可抽取的文字层。
   * false（扫描版）时文字能力（搜索/划线/朗读）不可用，阅读页只给原版视图。
   */
  hasText?: boolean
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
