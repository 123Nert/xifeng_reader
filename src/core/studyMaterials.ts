import { chapterIndexOf, type HighlightRecord } from './highlight'
import { buildToc } from './toc'
import { normalizeVocabRecord, type VocabRecord } from './vocabulary'

export type StudyMaterialType = 'highlight' | 'vocab'

export interface StudyBook {
  id: string
  title: string
  content?: string
  tocPattern?: string
  tocEntries?: Array<{ title: string; charIndex: number }>
}

export interface StudyMaterial {
  id: string
  type: StudyMaterialType
  bookId: string
  bookTitle: string
  chapterIndex?: number
  chapterTitle?: string
  charIndex: number
  text: string
  note?: string
  word?: string
  gloss?: string
  alt?: string
  context?: string
  color?: HighlightRecord['color']
  style?: HighlightRecord['style']
  createdAt: number
  reviewStep?: number
  dueAt?: number
  lastReviewedAt?: number
}

export interface StudyMaterialFilters {
  bookId?: string
  chapterIndex?: number | 'all'
  type?: StudyMaterialType | 'all'
  query?: string
  dueOnly?: boolean
  now?: number
}

export function buildStudyMaterials(
  books: StudyBook[],
  highlights: HighlightRecord[],
  vocabulary: VocabRecord[],
): StudyMaterial[] {
  const booksById = new Map(books.map((book) => [book.id, book]))
  const tocByBook = new Map(books.map((book) => [
    book.id,
    book.tocEntries?.length ? book.tocEntries : buildToc(book.content ?? '', book.tocPattern).entries,
  ]))
  const chapterAt = (bookId: string, charIndex: number, preferred?: number) => {
    const entries = tocByBook.get(bookId) ?? []
    const chapterIndex = preferred != null && entries[preferred]
      ? preferred
      : chapterIndexOf(entries, charIndex)
    return { chapterIndex, chapterTitle: chapterIndex == null ? undefined : entries[chapterIndex]?.title }
  }
  const items: StudyMaterial[] = []

  for (const highlight of highlights) {
    const book = booksById.get(highlight.bookId)
    if (!book) continue
    items.push({
      id: `highlight:${highlight.id}`,
      type: 'highlight',
      bookId: book.id,
      bookTitle: book.title,
      ...chapterAt(book.id, highlight.start, highlight.chapterIndex),
      charIndex: highlight.start,
      text: highlight.text,
      ...(highlight.note ? { note: highlight.note } : {}),
      color: highlight.color,
      style: highlight.style,
      createdAt: highlight.createdAt,
    })
  }

  for (const rawRecord of vocabulary) {
    const record = normalizeVocabRecord(rawRecord)
    for (const source of record.sources ?? []) {
      const book = booksById.get(source.bookId)
      if (!book) continue
      items.push({
        id: `vocab:${record.word}:${source.bookId}:${source.charIndex}`,
        type: 'vocab',
        bookId: book.id,
        bookTitle: book.title,
        ...chapterAt(book.id, source.charIndex),
        charIndex: source.charIndex,
        text: source.excerpt,
        word: record.word,
        gloss: source.gloss ?? record.gloss,
        ...(source.alt ?? record.alt ? { alt: source.alt ?? record.alt } : {}),
        ...(source.context ?? record.context ? { context: source.context ?? record.context } : {}),
        createdAt: record.createdAt,
        reviewStep: record.reviewStep,
        dueAt: record.dueAt,
        lastReviewedAt: record.lastReviewedAt,
      })
    }
  }

  return items.sort((a, b) => a.bookTitle.localeCompare(b.bookTitle)
    || (a.chapterIndex ?? -1) - (b.chapterIndex ?? -1)
    || a.charIndex - b.charIndex)
}

export function filterStudyMaterials(
  items: StudyMaterial[],
  filters: StudyMaterialFilters = {},
): StudyMaterial[] {
  const query = filters.query?.trim().toLocaleLowerCase() ?? ''
  const now = filters.now ?? Date.now()
  return items.filter((item) => {
    if (filters.bookId && filters.bookId !== 'all' && item.bookId !== filters.bookId) return false
    if (filters.chapterIndex != null && filters.chapterIndex !== 'all' && item.chapterIndex !== filters.chapterIndex) return false
    if (filters.type && filters.type !== 'all' && item.type !== filters.type) return false
    if (filters.dueOnly && (item.type !== 'vocab' || (item.dueAt != null && item.dueAt > now))) return false
    if (query) {
      const searchable = [item.text, item.note, item.word, item.gloss, item.alt, item.context]
        .filter(Boolean).join(' ').toLocaleLowerCase()
      if (!searchable.includes(query)) return false
    }
    return true
  })
}

export function studyMaterialsToMarkdown(items: StudyMaterial[], now = new Date()): string {
  const lines = [
    '# 学习资料',
    '',
    `> 导出时间：${now.toLocaleString()} · 共 ${items.length} 条`,
    '',
  ]
  let previousBook = ''
  let previousChapter = ''
  for (const item of items) {
    if (item.bookId !== previousBook) {
      previousBook = item.bookId
      previousChapter = ''
      lines.push(`## ${item.bookTitle}`, '')
    }
    const chapter = item.chapterTitle ?? '未归类章节'
    if (chapter !== previousChapter) {
      previousChapter = chapter
      lines.push(`### ${chapter}`, '')
    }
    if (item.type === 'highlight') {
      lines.push(`- [批注 · ${item.color ?? ''} / ${item.style ?? ''}] ${item.text}`)
      if (item.note) lines.push(`  - 笔记：${item.note}`)
    } else {
      lines.push(`- [生词] ${item.word ?? ''} — ${item.gloss ?? ''}`)
      if (item.context) lines.push(`  - 语境：${item.context}`)
      if (item.text) lines.push(`  - 原文：${item.text}`)
    }
  }
  return lines.join('\n')
}

function csvCell(value: string | number | undefined): string {
  const normalized = String(value ?? '').replaceAll('"', '""').replace(/[\r\n]/g, ' ')
  return `"${normalized}"`
}

export function studyMaterialsToCsv(items: StudyMaterial[]): string {
  const header = 'type,book,chapter,position,text,note,word,gloss,context,color,style,dueAt'
  const rows = items.map((item) => [
    item.type, item.bookTitle, item.chapterTitle, item.charIndex, item.text, item.note,
    item.word, item.gloss, item.context, item.color, item.style, item.dueAt,
  ].map(csvCell).join(','))
  return `\uFEFF${[header, ...rows].join('\r\n')}`
}