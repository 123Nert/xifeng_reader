/**
 * html.ts — HTML/XHTML 文本抽取（V5.0，纯函数，两端可测）。
 *
 * 不依赖 DOMParser：用轻量解析完成"块级标签转换行 + 标签剥离 + 实体解码"，
 * 在 Node（单测）与浏览器（运行时）行为一致。
 */

/** 常见命名实体 ↔ 字符。 */
const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  deg: '°',
  times: '×',
  divide: '÷',
}

/** 解码 HTML 实体（命名 + 十进制 + 十六进制）。 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? safeFromCodePoint(code) : m
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? safeFromCodePoint(code) : m
    }
    const v = ENTITIES[body.toLowerCase()]
    return v !== undefined ? v : m
  })
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** 需要在前后产生换行的块级/结构标签。 */
const BLOCK_TAGS = [
  'p',
  'div',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'tr',
  'td',
  'th',
  'section',
  'article',
  'header',
  'footer',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'table',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'nav',
  'aside',
]

export interface HtmlExtractResult {
  text: string
  /** 抽取到的标题（按出现顺序，不含偏移——偏移由调用方在拼接时记录） */
  headings: string[]
  /** <title> 内容（若有） */
  docTitle: string | null
}

/**
 * 把一段 HTML/XHTML 转成纯文本。
 * - 丢弃 head/script/style/svg 内容
 * - 块级标签转换行
 * - 剥离其它标签、解码实体
 * - 折叠 3 个以上连续换行为 1 个空行
 */
export function htmlToText(html: string): HtmlExtractResult {
  let s = html

  // 去掉注释、脚本、样式、SVG、head 内非标题内容
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '')
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, '')
  // head 整体丢弃：<title> 仅用于书名兜底，不混入正文（避免与正文标题重复进目录）
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '')

  const docTitleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const docTitle = docTitleMatch ? decodeEntities(docTitleMatch[1]).trim() || null : null

  // 标题：记录内容并转换行（内容稍后从纯文本里提取）
  const headings: string[] = []
  s = s.replace(/<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner: string) => {
    const t = decodeEntities(stripTags(inner)).trim()
    if (t) headings.push(t)
    return `\n${t}\n`
  })

  // 块级标签 → 换行
  const blockRe = new RegExp(`</?(?:${BLOCK_TAGS.join('|')})(?:\\s[^>]*)?/?>`, 'gi')
  s = s.replace(blockRe, '\n')

  // 剥离剩余标签
  s = stripTags(s)

  // 解码实体
  s = decodeEntities(s)

  // 规范化空白：去行首尾空白、折叠 3+ 换行
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { text: s, headings, docTitle }
}

/** 只剥标签，不解码实体（内部复用）。 */
function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '')
}

/** 从 HTML 里提取标题文本列表（供目录构建，不关心正文）。 */
export function extractHeadings(html: string): string[] {
  return htmlToText(html).headings
}

/** 判断给定字符串是否像 HTML（用于格式探测）。 */
export function looksLikeHtml(s: string): boolean {
  const head = s.slice(0, 2000).toLowerCase()
  return /<!doctype html|<html[\s>]|<body[\s>]|<head[\s>]/.test(head)
}
