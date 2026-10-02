import { describe, expect, it } from 'vitest'
import {
  buildStudyMaterials,
  computeStreak,
  filterStudyMaterials,
  studyMaterialsToCsv,
  studyMaterialsToMarkdown,
  summarizeReview,
} from './studyMaterials'
import type { HighlightRecord } from './highlight'
import type { VocabRecord } from './vocabulary'

const content = 'Opening river bank. Later river bank.'
const books = [{
  id: 'b1',
  title: 'River Book',
  content,
  tocEntries: [
    { title: 'Chapter One', charIndex: 0 },
    { title: 'Chapter Two', charIndex: 22 },
  ],
}]
const highlights: HighlightRecord[] = [{
  id: 'h1', bookId: 'b1', start: 8, end: 18, text: 'river bank', color: 'yellow',
  style: 'highlight', note: 'important idea', createdAt: 100, chapterIndex: 0,
}]
const vocabulary: VocabRecord[] = [{
  word: 'bank', bookId: 'b1', charIndex: 27, excerpt: 'river bank', gloss: 'river side',
  lookups: 1, createdAt: 100, lastLookupAt: 100, dueAt: 150,
  sources: [
    { bookId: 'b1', charIndex: 8, excerpt: 'river bank', gloss: 'financial institution' },
    { bookId: 'b1', charIndex: 27, excerpt: 'river bank', gloss: 'river side' },
  ],
}]

describe('study materials', () => {
  it('expands vocabulary cards by source and derives chapter names', () => {
    const items = buildStudyMaterials(books, highlights, vocabulary)
    expect(items).toHaveLength(3)
    expect(items.filter((item) => item.type === 'vocab')).toHaveLength(2)
    expect(items.find((item) => item.type === 'vocab' && item.charIndex === 27)?.chapterTitle).toBe('Chapter Two')
  })

  it('combines book, chapter, type, due-state and full-text filters', () => {
    const items = buildStudyMaterials(books, highlights, vocabulary)
    const results = filterStudyMaterials(items, {
      bookId: 'b1', chapterIndex: 1, type: 'vocab', query: 'river side', dueOnly: true, now: 200,
    })
    expect(results).toHaveLength(1)
    expect(results[0].word).toBe('bank')
    expect(filterStudyMaterials(items, { query: 'important idea' })).toHaveLength(1)
    expect(filterStudyMaterials(items, { dueOnly: true, now: 200 })).toHaveLength(2)
  })

  it('exports grouped Markdown and escaped UTF-8 CSV', () => {
    const items = buildStudyMaterials(books, highlights, vocabulary)
    const markdown = studyMaterialsToMarkdown(items, new Date(0))
    expect(markdown).toContain('# 学习资料')
    expect(markdown).toContain('## River Book')
    expect(markdown).toContain('### Chapter Two')
    const csv = studyMaterialsToCsv([{ ...items[0], text: 'comma, and "quote"\nnext line' }])
    expect(csv.charCodeAt(0)).toBe(65279)
    expect(csv.split('\r\n')).toHaveLength(2)
    expect(csv).toContain('"comma, and ""quote"" next line"')
  })
})

describe('review summary（V6.8 复习统计）', () => {
  const now = new Date('2026-10-02T12:00:00')
  const day = (offset: number) => {
    const d = new Date(now)
    d.setDate(d.getDate() - offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const vocab = (over: Partial<VocabRecord>): VocabRecord => ({
    word: 'w', bookId: 'b1', charIndex: 0, excerpt: '', gloss: 'g',
    lookups: 1, createdAt: 0, lastLookupAt: 0, ...over,
  })

  it('到期 / 学习中 / 已掌握 口径正确', () => {
    const records = [
      vocab({ word: 'due', dueAt: now.getTime() - 1000 }),            // 到期
      vocab({ word: 'future', dueAt: now.getTime() + 86400000 }),     // 未到期，学习中
      vocab({ word: 'fresh' }),                                       // 无 dueAt（待首复习），到期
      vocab({ word: 'mastered', reviewStep: 6, dueAt: now.getTime() + 90 * 86400000 }), // 毕业
      vocab({ word: 'mastered-due', reviewStep: 6, dueAt: now.getTime() - 1000 }),      // 毕业即使到期也不算
    ]
    const summary = summarizeReview(records, [], now)
    expect(summary.dueCount).toBe(2)
    // 学习中 = 未毕业的全部生词（due + future + fresh）
    expect(summary.learningCount).toBe(3)
    expect(summary.masteredCount).toBe(2)
  })

  it('连续天数：今天没复习不断签，断档一天归零重计', () => {
    // 昨天、前天复习过 → 连续 2 天（今天还没复习不打断）
    expect(computeStreak([day(1), day(2)], now)).toBe(2)
    // 今天也复习了 → 连续 3 天
    expect(computeStreak([day(0), day(1), day(2)], now)).toBe(3)
    // 昨天断档 → 只有今天的 1 天
    expect(computeStreak([day(0), day(3), day(4)], now)).toBe(1)
    // 完全没复习 → 0
    expect(computeStreak([], now)).toBe(0)
  })
})