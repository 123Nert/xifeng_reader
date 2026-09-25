/**
 * search.ts — 全文搜索（V1.2，纯函数）。
 *
 * 单次 indexOf 扫描返回全部命中（字符偏移 + 摘要上下文），
 * 百万字文本毫秒级完成，无需预建索引（技术方案 §5 风险表结论）。
 * 跳转 = PageMap.jumpTo(charIndex)，与目录/进度同一坐标系。
 */

export interface SearchHit {
  /** 命中起始字符偏移 */
  charIndex: number
  /** 命中词长度 */
  length: number
  /** 命中处的上下文摘要（已折叠空白） */
  excerpt: string
}

const DEFAULT_LIMIT = 200
const CONTEXT = 24

/** 折叠连续空白为单个空格（用于摘要展示）。 */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 在全文中搜索 query（英文忽略大小写，中文原样匹配）。
 * 返回按出现顺序排列的命中，最多 limit 条防止极端长文卡顿。
 * query 为空白时返回空数组。
 */
export function searchText(text: string, query: string, limit = DEFAULT_LIMIT): SearchHit[] {
  const q = query.trim()
  if (!q || !text) return []

  const haystack = text.toLowerCase()
  const needle = q.toLowerCase()
  const hits: SearchHit[] = []
  let from = 0

  while (hits.length < limit) {
    const idx = haystack.indexOf(needle, from)
    if (idx < 0) break
    hits.push({
      charIndex: idx,
      length: q.length,
      excerpt: collapse(text.slice(Math.max(0, idx - CONTEXT), idx + q.length + CONTEXT)),
    })
    from = idx + 1 // 步长 1：重叠命中也不漏报
  }
  return hits
}
