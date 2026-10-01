import { describe, expect, it } from 'vitest'
import { buildStudyMaterials, filterStudyMaterials, studyMaterialsToCsv, studyMaterialsToMarkdown } from './studyMaterials'
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