/**
 * vocabulary.ts — 生词本（V6.6，纯逻辑层）。
 *
 * 划词翻译（V6.4）查完就丢；生词本把"查过的词"攒下来：
 * 词 + 释义 + 所在整句语境 + 出处（哪本书哪个字符偏移），可回看、可导出。
 *
 * 对标 KOReader vocabbuilder / Kindle Vocabulary Builder。V6.8 起复习排期
 * 升级为艾宾浩斯遗忘曲线周期（[1,2,4,7,15,30] 天，遗忘回退 2 级不归零，
 * 毕业进长期维护），留存率仅作展示级估算 —— 见 docs/V6.8-科学记忆与复习方案.md。
 *
 * 本文件全部纯函数：归一化、候选判定、记录组装、重复合并、导出文本。
 * IndexedDB 读写在 bookRepository.ts（vocab store，DB v7）。
 */

import { isWordLookup, type TranslationResult } from './translate'

/** 一条生词记录（IndexedDB vocab store 的 value；主键是归一化后的词）。 */
export interface VocabRecord {
  sources?: VocabSource[]
  reviewStep?: number
  dueAt?: number
  lastReviewedAt?: number

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

export interface VocabSource {
  bookId: string
  charIndex: number
  excerpt: string
  gloss?: string
  alt?: string
  context?: string
}

/**
 * 艾宾浩斯遗忘曲线的复习周期（V6.8，日粒度）。
 * 经典节点 5min/30min/12h 在阅读器场景不实用，取其日粒度骨架：
 * 1 / 2 / 4 / 7 / 15 / 30 天，复习满 6 级 = 走完全部周期 → 毕业（长期记忆），
 * 此后按 MAINTENANCE_INTERVAL_DAYS 低频维护。
 */
export const EBBINGHAUS_INTERVAL_DAYS = [1, 2, 4, 7, 15, 30]
/** 毕业后的维护间隔（天）：不再进"待复习"主循环，只是极低频地露面。 */
export const MAINTENANCE_INTERVAL_DAYS = 90
/** 遗忘时回退的级数：留存是指数衰减不是清零，退 2 级 = 从最近的稳固节点重爬。 */
export const FORGET_STEP_BACK = 2

const DAY_MS = 24 * 60 * 60 * 1000

export function normalizeVocabRecord(record: VocabRecord): VocabRecord {
  const sourceList = Array.isArray(record.sources) && record.sources.length > 0
    ? record.sources
    : [{
        bookId: record.bookId,
        charIndex: record.charIndex,
        excerpt: record.excerpt,
        gloss: record.gloss,
        alt: record.alt,
        context: record.context,
      }]
  const sources = sourceList.map((source) => ({
    bookId: source.bookId,
    charIndex: source.charIndex,
    excerpt: source.excerpt ?? '',
    ...(source.gloss ? { gloss: source.gloss } : {}),
    ...(source.alt ? { alt: source.alt } : {}),
    ...(source.context ? { context: source.context } : {}),
  }))
  return {
    ...record,
    sources,
    reviewStep: Number.isInteger(record.reviewStep) ? Math.max(0, record.reviewStep!) : 0,
  }
}

/** 是否已毕业（走完艾宾浩斯全部周期，进入长期记忆维护状态）。 */
export function isVocabMastered(record: VocabRecord): boolean {
  return (normalizeVocabRecord(record).reviewStep ?? 0) >= EBBINGHAUS_INTERVAL_DAYS.length
}

export function reviewVocabRecord(
  record: VocabRecord,
  remembered: boolean,
  now = Date.now(),
): VocabRecord {
  const normalized = normalizeVocabRecord(record)
  const step = normalized.reviewStep ?? 0
  if (remembered) {
    // 已毕业：只在维护间隔上低频露面
    if (step >= EBBINGHAUS_INTERVAL_DAYS.length) {
      return {
        ...normalized,
        reviewStep: step,
        dueAt: now + MAINTENANCE_INTERVAL_DAYS * DAY_MS,
        lastReviewedAt: now,
      }
    }
    // 在第 k 级记住 → 经历 interval[k] 天的周期，然后升到第 k+1 级。
    // 第 6 次记住（k=5）经历完 30 天周期才真正毕业。
    const intervalDays = EBBINGHAUS_INTERVAL_DAYS[Math.min(step, EBBINGHAUS_INTERVAL_DAYS.length - 1)]
    return {
      ...normalized,
      reviewStep: step + 1,
      dueAt: now + intervalDays * DAY_MS,
      lastReviewedAt: now,
    }
  }
  // 忘了：回退 2 级（不归零，艾宾浩斯留存衰减 ≠ 记忆清零），明天重新见面
  const backStep = Math.max(step - FORGET_STEP_BACK, 0)
  return {
    ...normalized,
    reviewStep: backStep,
    dueAt: now + DAY_MS,
    lastReviewedAt: now,
  }
}

/**
 * 艾宾浩斯留存率的展示级估算（V6.8）：R = e^(-t / S)。
 * t = 距上次复习的天数；S = 当前级别的间隔天数（新词 S=1，毕业词 S=90）。
 * 只做展示（"这个词条大概还记得几成"），不是调度依据。
 */
export function retentionEstimate(record: VocabRecord, now = Date.now()): number {
  const normalized = normalizeVocabRecord(record)
  const step = normalized.reviewStep ?? 0
  const mastered = step >= EBBINGHAUS_INTERVAL_DAYS.length
  const stabilityDays = mastered
    ? MAINTENANCE_INTERVAL_DAYS
    : EBBINGHAUS_INTERVAL_DAYS[Math.min(step, EBBINGHAUS_INTERVAL_DAYS.length - 1)]
  const anchor = normalized.lastReviewedAt ?? normalized.createdAt ?? now
  const elapsedDays = Math.max(0, (now - anchor) / DAY_MS)
  const retention = Math.exp(-elapsedDays / stabilityDays)
  return Math.round(Math.min(1, Math.max(0, retention)) * 100)
}

export function isVocabDue(record: VocabRecord, now = Date.now()): boolean {
  if (isVocabMastered(record)) return false
  return !Number.isFinite(record.dueAt) || record.dueAt! <= now
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
  const excerpt = input.sentence ? clip(input.sentence, CONTEXT_MAX_CHARS) : ''
  const gloss = clip(input.result.text, GLOSS_MAX_CHARS)
  const source: VocabSource = {
    bookId: input.bookId,
    charIndex: input.charIndex,
    excerpt,
    gloss,
    ...(input.result.alt ? { alt: clip(input.result.alt, GLOSS_MAX_CHARS) } : {}),
    ...(input.result.context ? { context: clip(input.result.context, GLOSS_MAX_CHARS) } : {}),
  }
  return {
    word: normalizeWord(input.source),
    bookId: input.bookId,
    charIndex: input.charIndex,
    excerpt,
    gloss,
    ...(input.result.alt ? { alt: clip(input.result.alt, GLOSS_MAX_CHARS) } : {}),
    ...(input.result.context ? { context: clip(input.result.context, GLOSS_MAX_CHARS) } : {}),
    lookups: 1,
    createdAt: now,
    lastLookupAt: now,
    sources: [source],
  }
}

/**
 * 重复收藏的合并策略（同词主键覆盖）：次数累加，语境/释义/出处更新为最近一次，
 * 首次收藏时间保留 —— "这个词我攒下过"和"我当时读到哪"两个信息都不丢。
 */
export function mergeVocabOnRecollection(existing: VocabRecord, next: VocabRecord): VocabRecord {
  const previous = normalizeVocabRecord(existing)
  const latest = normalizeVocabRecord(next)
  const sources = [...(previous.sources ?? [])]
  for (const source of latest.sources ?? []) {
    const index = sources.findIndex(
      (item) => item.bookId === source.bookId && item.charIndex === source.charIndex,
    )
    if (index >= 0) sources[index] = source
    else sources.push(source)
  }
  return {
    ...latest,
    lookups: (existing.lookups ?? 0) + 1,
    createdAt: existing.createdAt,
    sources,
    reviewStep: previous.reviewStep,
    ...(previous.dueAt != null ? { dueAt: previous.dueAt } : {}),
    ...(previous.lastReviewedAt != null ? { lastReviewedAt: previous.lastReviewedAt } : {}),
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
