/**
 * vocabulary.ts — 生词本（V6.6，纯逻辑层）。
 *
 * 划词翻译（V6.4）查完就丢；生词本把"查过的词"攒下来：
 * 词 + 释义 + 所在整句语境 + 出处（哪本书哪个字符偏移），可回看、可导出。
 *
 * 对标 KOReader vocabbuilder / Kindle Vocabulary Builder，但本期只做
 * "收 + 管 + 导出"（见 docs/V6.6-生词本方案.md §3.6）：
 * 间隔复习（SRS）待 V6.7，全局跨书面板待产品验证后立项。
 *
 * 本文件全部纯函数：归一化、候选判定、记录组装、重复合并、导出文本。
 * IndexedDB 读写在 bookRepository.ts（vocab store，DB v7）。
 */

import { isWordLookup, type TranslationResult } from './translate'

/** 一条生词记录（IndexedDB vocab store 的 value；主键是归一化后的词）。 */
export interface VocabRecord {
  /** 归一化后的词（小写、去标点壳）：主键，同词跨书唯一 */
  word: string
  /** 最近一次收藏时的书（跳回出处 + 书内过滤用） */
  bookId: string
  /** 最近一次收藏时选区起点的字符偏移（回看出处 = jumpToOffset） */
  charIndex: number
  /** 收藏时所在的整句（语境），最长 CONTEXT_MAX_CHARS */
  excerpt: string
  /** 主译文（翻译浮卡的 result.text） */
  gloss: string
  /** 另一常见义项（result.alt，可选） */
  alt?: string
  /** 所在整句的译文（result.context，可选） */
  context?: string
  /** 收藏次数：同一词再收藏不新增记录，只累加（KOReader lookup count 同思路） */
  lookups: number
  /** 首次收藏时刻 */
  createdAt: number
  /** 最近一次收藏时刻 */
  lastLookupAt: number
}

/** 语境（整句）最长保留字符数：再长的句子截断展示也够回忆现场了。 */
export const CONTEXT_MAX_CHARS = 200

/** 释义最长保留字符数：接口偶发超长译文，防记录虚胖。 */
export const GLOSS_MAX_CHARS = 300

/** 选中时容易"带上的壳"：首尾出现这些字符就剥掉（well-known 的连字符不剥）。 */
const WORD_SHELL_RE = /^[^[a-zA-Z0-9\u3400-\u9fff\u3040-\u30ff]+|[^[a-zA-Z0-9\u3400-\u9fff\u3040-\u30ff]+$/g

/**
 * 归一化成生词主键：trim → 去首尾标点壳 → 内部空白折叠 → 小写。
 * 全是标点时得到空串，调用方须用 isVocabCandidate 拒掉。
 */
export function normalizeWord(text: string): string {
  const t = text.trim().replace(WORD_SHELL_RE, '').replace(/\s+/g, ' ')
  return t.toLowerCase()
}

/** 能否收进生词本：只收"词"（1~3 个词、≤24 字符，复用查词判定），整段翻译不收。 */
export function isVocabCandidate(text: string): boolean {
  return isWordLookup(text) && normalizeWord(text).length > 0
}

/** 截断到 max 字符，尾缀省略号让截断可见。 */
function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}

/**
 * 从一次"选中 + 翻译结果"组装生词记录（新词，lookups = 1）。
 * 语境（sentence）由调用方用 sentenceAround 取好传入；没有也不强求（记空串）。
 */
export function buildVocabRecord(input: {
  source: string
  bookId: string
  charIndex: number
  sentence?: string
  result: Pick<TranslationResult, 'text' | 'alt' | 'context'>
  now?: number
}): VocabRecord {
  const now = input.now ?? Date.now()
  return {
    word: normalizeWord(input.source),
    bookId: input.bookId,
    charIndex: input.charIndex,
    excerpt: input.sentence ? clip(input.sentence, CONTEXT_MAX_CHARS) : '',
    gloss: clip(input.result.text, GLOSS_MAX_CHARS),
    ...(input.result.alt ? { alt: clip(input.result.alt, GLOSS_MAX_CHARS) } : {}),
    ...(input.result.context ? { context: clip(input.result.context, GLOSS_MAX_CHARS) } : {}),
    lookups: 1,
    createdAt: now,
    lastLookupAt: now,
  }
}

/**
 * 重复收藏的合并策略（同词主键覆盖）：次数累加，语境/释义/出处更新为最近一次，
 * 首次收藏时间保留 —— "这个词我攒下过"和"我当时读到哪"两个信息都不丢。
 */
export function mergeVocabOnRecollection(existing: VocabRecord, next: VocabRecord): VocabRecord {
  return {
    ...next,
    lookups: (existing.lookups ?? 0) + 1,
    createdAt: existing.createdAt,
  }
}

// ---------- 导出（回看场景：Markdown 人读 / CSV 喂 Anki） ----------

/** 导出 Markdown：书名标题 + 时间 + 条目数，每条是"词 > 释义 > 语境"的引用块。 */
export function vocabToMarkdown(records: VocabRecord[], bookTitle: string, now = new Date()): string {
  const lines = [`# 《${bookTitle}》生词本`, '']
  lines.push(`> 导出时间：${now.toLocaleString()} · 共 ${records.length} 个生词`)
  lines.push('')
  for (const r of records) {
    lines.push(`## ${r.word}`)
    lines.push('')
    lines.push(`> ${r.gloss}`)
    if (r.alt) lines.push(`> 也作：${r.alt}`)
    if (r.context) lines.push(`> 整句：${r.context}`)
    if (r.excerpt) lines.push(`> 原句：${r.excerpt}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** CSV 单字段转义：引号包裹、内部引号加倍、换行压成空格（Excel/Anki 双兼容）。 */
function csvCell(s: string): string {
  return '"' + s.replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"'
}

/**
 * 导出 CSV：Anki 可直接吃的三列（词 / 释义 / 语境）。
 * 首加 BOM，Excel 打开 UTF-8 中文才不乱码。
 */
export function vocabToCsv(records: VocabRecord[]): string {
  const head = 'word,gloss,context'
  const rows = records.map((r) =>
    [csvCell(r.word), csvCell(r.gloss), csvCell(r.context ?? r.excerpt)].join(','),
  )
  return '\uFEFF' + [head, ...rows].join('\r\n')
}
