/**
 * toc.ts — 章节切分（V1.1，纯函数）。
 *
 * 内置常见"第X章/回/卷"类标题模式，并支持用户自定义正则（对标 Legado）。
 * 输出 [{ title, charIndex }] 与 PageMap 同一坐标系（字符偏移），
 * 目录跳转 = PageMap.jumpTo(charIndex)；识别失败优雅降级为无目录。
 */

export interface TocEntry {
  title: string
  charIndex: number
}

export type TocSource = 'builtin' | 'custom' | 'none'

export interface Toc {
  entries: TocEntry[]
  source: TocSource
  /** 自定义正则无效等错误信息，供 UI 展示 */
  error?: string
}

/**
 * 内置标题模式（保守起步，误切时用户可用自定义正则覆盖）：
 * 1. "第[数字/中文数字]章/节/回/卷/部/集/篇"，标题须以空白分隔（避免"第二章正文。"这类句子误切）
 * 2. "Chapter 1 / CHAPTER II" 式英文标题
 * 3. 序章/楔子/引子/尾声 等特殊章节
 */
const BUILTIN_PATTERNS = [
  /^\s*第\s*[〇○零一二三四五六七八九十百千万两0-9]{1,7}\s*[章节回卷部集篇](?:\s[^\n]{0,40})?$/,
  /^\s*卷\s*[〇○零一二三四五六七八九十百千万两0-9]{1,7}(?:\s[^\n]{0,40})?$/,
  /^\s*[Cc]hapter\s+[0-9IVXivx]{1,7}(?:\s[^\n]{0,40})?$/,
  /^\s*(?:序章|楔子|引子|序言|前言|尾声|后记|终章)(?:\s[^\n]{0,30})?$/,
]

/** 章节标题行的合理长度上限，超过视为正文误匹配（仅内置模式使用）。 */
const BUILTIN_TITLE_MAX_LEN = 60

/** 防御性上限：误切出数千章时截断，避免目录卡死。 */
const MAX_ENTRIES = 5000

export interface TextLine {
  text: string
  start: number
}

/** 按行切分并记录每行在全文中的起始字符偏移（兼容 \r\n 与 \n）。 */
export function splitLinesWithOffsets(text: string): TextLine[] {
  const lines: TextLine[] = []
  let start = 0
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      lines.push({ text: text.slice(start, i).replace(/\r$/, ''), start })
      start = i + 1
    }
  }
  return lines
}

/**
 * 生成目录。
 * @param text 全文
 * @param customPattern 用户自定义正则（提供且有效时优先于内置模式）
 */
export function buildToc(text: string, customPattern?: string): Toc {
  if (!text) return { entries: [], source: 'none' }

  let re: RegExp | null = null
  let source: TocSource = 'builtin'
  if (customPattern && customPattern.trim()) {
    try {
      re = new RegExp(customPattern.trim())
      source = 'custom'
    } catch (e) {
      return { entries: [], source: 'none', error: `正则表达式无效：${(e as Error).message}` }
    }
  }

  const isTitle = (lineText: string): boolean => {
    const t = lineText.trim()
    if (!t) return false
    if (re) return re.test(lineText)
    return t.length <= BUILTIN_TITLE_MAX_LEN && BUILTIN_PATTERNS.some((p) => p.test(lineText))
  }

  const entries: TocEntry[] = []
  for (const line of splitLinesWithOffsets(text)) {
    if (isTitle(line.text)) {
      entries.push({ title: line.text.trim(), charIndex: line.start })
      if (entries.length >= MAX_ENTRIES) break
    }
  }
  if (entries.length === 0) return { entries: [], source: 'none' }

  // 首章之前还有正文（序言等）时，补一个"开篇"入口保证全文可达
  if (entries[0].charIndex > 0) entries.unshift({ title: '开篇', charIndex: 0 })
  return { entries, source }
}

/**
 * 当前页所在章节下标：最后一个 charIndex <= charIndex 的条目。
 * 返回 -1 表示第一章之前（例如正在读"开篇"之前的空文本）。
 */
export function currentChapterIndex(entries: TocEntry[], charIndex: number): number {
  let lo = 0
  let hi = entries.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (entries[mid].charIndex <= charIndex) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}
