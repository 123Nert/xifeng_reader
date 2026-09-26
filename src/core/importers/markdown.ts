/**
 * markdown.ts — Markdown 导入（V5.0，纯函数）。
 * 去标记保留内容：标题进目录，代码块内容保留，行内标记剥离。
 */
import type { TocEntryLite } from './types'

export interface MarkdownResult {
  text: string
  tocEntries: TocEntryLite[]
  title: string | null
  headings: string[]
}

/** 去掉行内标记（粗体/斜体/行内代码/链接/图片）。 */
export function stripInlineMd(line: string): string {
  let s = line
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片 → alt 文本
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接 → 文字
  s = s.replace(/`([^`]*)`/g, '$1') // 行内代码
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/\*([^*]+)\*/g, '$1')
  s = s.replace(/_([^_]+)_/g, '$1')
  s = s.replace(/~~([^~]+)~~/g, '$1')
  return s
}

export function parseMarkdown(md: string): MarkdownResult {
  const lines = md.split(/\r?\n/)
  const out: string[] = []
  const headings: string[] = []
  const tocEntries: TocEntryLite[] = []
  let title: string | null = null
  let inFence = false
  let cursor = 0

  const push = (text: string) => {
    if (cursor > 0) {
      out.push('\n')
      cursor += 1
    }
    out.push(text)
    cursor += text.length
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')

    // 代码围栏：内容保留，围栏行丢弃
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      push(line)
      continue
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1].length
      const text = stripInlineMd(h[2]).trim()
      if (!text) continue
      if (level === 1 && !title) title = text
      if (level <= 3) headings.push(text)
      const at = cursor > 0 ? cursor + 1 : 0 // 实际写入位置（前面会补一个换行）
      push(text)
      if (level <= 3) tocEntries.push({ title: text, charIndex: at })
      continue
    }

    // 分隔线 → 丢弃
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) continue

    // 引用 / 列表：去前缀保留内容
    const stripped = line
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s{0,3}[-*+]\s+/, '')
      .replace(/^\s{0,3}\d+[.)]\s+/, '')

    const text = stripInlineMd(stripped).trim()
    if (!text) continue
    push(text)
  }

  // 多行段落之间已用单个 \n 分隔；把连续 3+ 换行折叠
  const text = out.join('').replace(/\n{3,}/g, '\n\n').trim()
  return { text, tocEntries, title, headings }
}
