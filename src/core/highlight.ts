/**
 * highlight.ts — 批注模型与锚定（V4.0，纯函数）。
 *
 * 设计依据见 docs/V4.0-批注与笔记方案.md §3：
 * - 颜色是语义编码（对标 KOReader 多色体系），样式与颜色正交；
 * - 锚定三层容错（W3C Web Annotation 的"多 selector 并存"思想）：
 *   L1 字符偏移 → L2 前后文引用匹配 → L3 章节内近似定位。
 * - 老数据（V3.0 只有 start/end/text）在**读取层归一化**，不改用户库。
 */

// ---------- 颜色与样式 ----------

export const HIGHLIGHT_COLORS = [
  'yellow',
  'green',
  'blue',
  'pink',
  'purple',
  'orange',
] as const
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number]
export const DEFAULT_HIGHLIGHT_COLOR: HighlightColor = 'yellow'

export const HIGHLIGHT_COLOR_LABELS: Record<HighlightColor, string> = {
  yellow: '黄',
  green: '绿',
  blue: '蓝',
  pink: '粉',
  purple: '紫',
  orange: '橙',
}

export const MARK_STYLES = ['highlight', 'underline', 'squiggly', 'strikeout'] as const
export type MarkStyle = (typeof MARK_STYLES)[number]
export const DEFAULT_MARK_STYLE: MarkStyle = 'highlight'
export const MARK_STYLE_LABELS: Record<MarkStyle, string> = {
  highlight: '高亮',
  underline: '下划线',
  squiggly: '波浪线',
  strikeout: '删除线',
}

// ---------- 记录结构 ----------

export interface HighlightRecord {
  id: string
  bookId: string
  /** L1 锚定：字符偏移 */
  start: number
  end: number
  /** L2 锚定：选区前后文（各 24 字），用于正文变更后重定位 */
  prefix?: string
  suffix?: string
  /** L3 锚定：所属章节序号（对应目录条目下标） */
  chapterIndex?: number
  /** 原文摘录 */
  text: string
  color: HighlightColor
  style: MarkStyle
  /** 想法（V4.0-b） */
  note?: string
  createdAt: number
  updatedAt?: number
}

/** 读取层归一化：老记录（V3.0）补默认值，保持原有视觉（默认黄色高亮）。 */
export function normalizeHighlight(raw: Partial<HighlightRecord> & { id: string; bookId: string }): HighlightRecord {
  return {
    id: raw.id,
    bookId: raw.bookId,
    start: typeof raw.start === 'number' ? raw.start : 0,
    end: typeof raw.end === 'number' ? raw.end : 0,
    prefix: raw.prefix,
    suffix: raw.suffix,
    chapterIndex: raw.chapterIndex,
    text: raw.text ?? '',
    color: HIGHLIGHT_COLORS.includes(raw.color as HighlightColor)
      ? (raw.color as HighlightColor)
      : DEFAULT_HIGHLIGHT_COLOR,
    style: MARK_STYLES.includes(raw.style as MarkStyle)
      ? (raw.style as MarkStyle)
      : DEFAULT_MARK_STYLE,
    note: raw.note,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: raw.updatedAt,
  }
}

// ---------- 锚定与重定位 ----------

/** 抓取选区前后文（用于 L2 锚定）。 */
export function anchorContext(
  text: string,
  start: number,
  end: number,
  contextLen = 24,
): { prefix: string; suffix: string } {
  return {
    prefix: text.slice(Math.max(0, start - contextLen), start),
    suffix: text.slice(end, Math.min(text.length, end + contextLen)),
  }
}

export interface RelocateResult {
  start: number
  end: number
  /** 命中层级：1 = 偏移直接可用，2 = 引用匹配，3 = 章节近似，0 = 失败 */
  level: 0 | 1 | 2 | 3
}

/**
 * 在（可能已变更的）正文中为批注重新定位。
 * @param content 当前正文全文
 * @param chapterRanges 各章节的字符区间（由目录推导，可为空）
 */
export function relocateHighlight(
  content: string,
  h: HighlightRecord,
  chapterRanges: Array<{ start: number; end: number }> = [],
): RelocateResult {
  const clamp = (v: number) => Math.max(0, Math.min(v, content.length))

  // L1：偏移仍在且原文能对上（正文未变）
  if (h.start >= 0 && h.end <= content.length && h.end > h.start) {
    const slice = content.slice(h.start, h.end)
    if (!h.text || slice === h.text) {
      return { start: h.start, end: h.end, level: 1 }
    }
  }

  // L2：前缀 + 原文 + 后缀 联合匹配；退化为仅原文，多处命中取最接近原偏移者
  if (h.text) {
    const withContext = h.prefix || h.suffix ? (h.prefix ?? '') + h.text + (h.suffix ?? '') : ''
    if (withContext) {
      const idx = content.indexOf(withContext)
      if (idx >= 0) {
        const s = idx + (h.prefix?.length ?? 0)
        return { start: s, end: s + h.text.length, level: 2 }
      }
    }
    const hits: number[] = []
    let from = 0
    for (;;) {
      const idx = content.indexOf(h.text, from)
      if (idx < 0) break
      hits.push(idx)
      from = idx + 1
      if (hits.length > 64) break // 病态输入保护
    }
    if (hits.length === 1) {
      return { start: hits[0], end: hits[0] + h.text.length, level: 2 }
    }
    if (hits.length > 1) {
      let best = hits[0]
      let bestDist = Infinity
      for (const idx of hits) {
        const d = Math.abs(idx - h.start)
        if (d < bestDist) {
          bestDist = d
          best = idx
        }
      }
      return { start: best, end: best + h.text.length, level: 2 }
    }
  }

  // L3：仅在所属章节范围内找原文；找不到则失败（明确告知，不静默错位）
  if (h.text && h.chapterIndex != null && h.chapterIndex >= 0 && h.chapterIndex < chapterRanges.length) {
    const range = chapterRanges[h.chapterIndex]
    const idx = content.slice(range.start, range.end).indexOf(h.text)
    if (idx >= 0) {
      const s = range.start + idx
      return { start: s, end: s + h.text.length, level: 3 }
    }
  }

  return { start: clamp(h.start), end: clamp(h.end), level: 0 }
}

/** 由目录条目推导章节区间（每章从自身起点到下一章起点）。 */
export function chapterRangesFromToc(
  entries: Array<{ charIndex: number }>,
  totalChars: number,
): Array<{ start: number; end: number }> {
  if (entries.length === 0) return []
  return entries.map((e, i) => ({
    start: e.charIndex,
    end: i + 1 < entries.length ? entries[i + 1].charIndex : totalChars,
  }))
}

/** 当前偏移命中的章节序号（用于新建批注时写入 chapterIndex）。 */
export function chapterIndexOf(
  entries: Array<{ charIndex: number }>,
  charIndex: number,
): number | undefined {
  if (entries.length === 0) return undefined
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
  return ans >= 0 ? ans : undefined
}
