/**
 * bookRepository.ts — IndexedDB 读写封装（技术方案 §3.2）。
 *
 * 数据库 xifeng-reader (v1)：
 *   books    (keyPath: id)     { id, title, content, size, charset, importedAt }
 *   progress (keyPath: bookId) { bookId, charIndex, updatedAt }
 *
 * 进度与正文分 store：翻页高频写进度，分开后每次只写几十字节，
 * 不会重写几 MB 的正文记录。
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { BookFormat } from './importers/types'
import {
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_MARK_STYLE,
  normalizeHighlight,
  type HighlightColor,
  type HighlightRecord,
  type MarkStyle,
} from './highlight'

export interface BookRecord {
  id: string
  title: string
  content: string
  /** 原文件字节数 */
  size: number
  /** 导入时探测到的编码 */
  charset: string
  importedAt: number
  /** V1.1：用户自定义章节正则（可选，空值走内置模式） */
  tocPattern?: string
  /** V5.0：来源格式（缺省视作 txt，老记录天然兼容） */
  format?: BookFormat
  /** V5.0：封面 data URL（EPUB 提取） */
  cover?: string
  /** V5.0：导入时解析的真实目录（优先于正则切分） */
  tocEntries?: Array<{ title: string; charIndex: number }>
  /** V5.0：作者 / 语言（EPUB 元信息） */
  author?: string
  language?: string
}

export interface ProgressRecord {
  bookId: string
  charIndex: number
  updatedAt: number
}

/** V1.2 书签：字符偏移定位 + 摘录便于辨认。 */
export interface BookmarkRecord {
  id: string
  bookId: string
  charIndex: number
  excerpt: string
  createdAt: number
}

/** V2.0 每日阅读统计（分钟），keyPath 为日期字符串。 */
export interface DayStatRecord {
  day: string
  minutes: number
}

// V4.0：批注模型（颜色/样式/锚定）见 core/highlight.ts，此处再导出便于调用方单点引入
export type { HighlightRecord } from './highlight'
export { normalizeHighlight } from './highlight'


/** 书库列表项：书籍元信息 + 合并后的阅读进度，不含正文。 */
export interface LibraryEntry {
  id: string
  title: string
  size: number
  charset: string
  importedAt: number
  charCount: number
  charIndex: number
  lastReadAt: number | null
  /** V5.0 */
  format?: BookFormat
  cover?: string
  author?: string
}

interface XifengDB extends DBSchema {
  books: { key: string; value: BookRecord }
  progress: { key: string; value: ProgressRecord }
  bookmarks: {
    key: string
    value: BookmarkRecord
    indexes: { 'by-book': string }
  }
  stats: { key: string; value: DayStatRecord }
  highlights: {
    key: string
    value: HighlightRecord
    indexes: { 'by-book': string }
  }
}

const DB_NAME = 'xifeng-reader'
const DB_VERSION = 4

let dbPromise: Promise<IDBPDatabase<XifengDB>> | null = null

function getDB(): Promise<IDBPDatabase<XifengDB>> {
  if (!dbPromise) {
    dbPromise = openDB<XifengDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('books', { keyPath: 'id' })
          db.createObjectStore('progress', { keyPath: 'bookId' })
        }
        if (oldVersion < 2) {
          const store = db.createObjectStore('bookmarks', { keyPath: 'id' })
          store.createIndex('by-book', 'bookId')
        }
        if (oldVersion < 3) {
          db.createObjectStore('stats', { keyPath: 'day' })
        }
        if (oldVersion < 4) {
          const store = db.createObjectStore('highlights', { keyPath: 'id' })
          store.createIndex('by-book', 'bookId')
        }
      },
    })
  }
  return dbPromise
}

export async function addBook(book: BookRecord): Promise<void> {
  const db = await getDB()
  await db.put('books', book)
}

export async function getBook(id: string): Promise<BookRecord | undefined> {
  const db = await getDB()
  return db.get('books', id)
}

export async function getBookContent(id: string): Promise<string | undefined> {
  return (await getBook(id))?.content
}

/**
 * 遍历 books 生成书库列表（游标逐条读取，只保留元信息，不长期持有正文），
 * 并合并 progress 得到阅读进度与最后阅读时间。
 */
export async function listLibrary(): Promise<LibraryEntry[]> {
  const db = await getDB()
  const entries: LibraryEntry[] = []
  let cursor = await db.transaction('books').store.openCursor()
  while (cursor) {
    const b = cursor.value
    entries.push({
      id: b.id,
      title: b.title,
      size: b.size,
      charset: b.charset,
      importedAt: b.importedAt,
      charCount: b.content.length,
      charIndex: 0,
      lastReadAt: null,
      format: b.format,
      cover: b.cover,
      author: b.author,
    })
    cursor = await cursor.continue()
  }

  const progressList = await db.getAll('progress')
  const byBook = new Map(progressList.map((p) => [p.bookId, p]))
  for (const e of entries) {
    const p = byBook.get(e.id)
    if (p) {
      e.charIndex = p.charIndex
      e.lastReadAt = p.updatedAt
    }
  }

  // 最近读过的在前，没读过的按导入时间倒序
  entries.sort((a, b) => (b.lastReadAt ?? b.importedAt) - (a.lastReadAt ?? a.importedAt))
  return entries
}

export async function deleteBook(id: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['books', 'progress'], 'readwrite')
  await Promise.all([
    tx.objectStore('books').delete(id),
    tx.objectStore('progress').delete(id),
    tx.done,
  ])
}

/** 每次翻页即写，记录体量极小，无需去抖。 */
export async function saveProgress(bookId: string, charIndex: number): Promise<void> {
  const db = await getDB()
  await db.put('progress', { bookId, charIndex, updatedAt: Date.now() })
}

/** 更新书籍的自定义章节正则；空串表示清除，恢复内置模式。 */
export async function updateBookTocPattern(id: string, pattern: string): Promise<void> {
  const db = await getDB()
  const book = await db.get('books', id)
  if (!book) return
  const trimmed = pattern.trim()
  if (trimmed) book.tocPattern = trimmed
  else delete book.tocPattern
  await db.put('books', book)
}

// ---------- 书签（V1.2） ----------

export async function addBookmark(
  bookId: string,
  charIndex: number,
  excerpt: string,
): Promise<BookmarkRecord> {
  const db = await getDB()
  const record: BookmarkRecord = {
    id: crypto.randomUUID(),
    bookId,
    charIndex,
    excerpt,
    createdAt: Date.now(),
  }
  await db.put('bookmarks', record)
  return record
}

/** 某本书的全部书签，按阅读位置升序。 */
export async function listBookmarks(bookId: string): Promise<BookmarkRecord[]> {
  const db = await getDB()
  const list = await db.getAllFromIndex('bookmarks', 'by-book', bookId)
  return list.sort((a, b) => a.charIndex - b.charIndex)
}

export async function deleteBookmark(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('bookmarks', id)
}

// ---------- 划线（V3.0） ----------

export async function addHighlight(
  bookId: string,
  start: number,
  end: number,
  text: string,
  options: {
    color?: HighlightColor
    style?: MarkStyle
    note?: string
    prefix?: string
    suffix?: string
    chapterIndex?: number
  } = {},
): Promise<HighlightRecord> {
  const db = await getDB()
  const record: HighlightRecord = {
    id: crypto.randomUUID(),
    bookId,
    start,
    end,
    text,
    color: options.color ?? DEFAULT_HIGHLIGHT_COLOR,
    style: options.style ?? DEFAULT_MARK_STYLE,
    ...(options.note ? { note: options.note } : {}),
    ...(options.prefix ? { prefix: options.prefix } : {}),
    ...(options.suffix ? { suffix: options.suffix } : {}),
    ...(options.chapterIndex != null ? { chapterIndex: options.chapterIndex } : {}),
    createdAt: Date.now(),
  }
  await db.put('highlights', record)
  return record
}

/**
 * 局部更新一条批注（改色/换样式/写想法）。不动锚定字段。
 * 传入 note 为空串表示清除想法。
 */
export async function updateHighlight(
  id: string,
  patch: Partial<Pick<HighlightRecord, 'color' | 'style' | 'note'>>,
): Promise<HighlightRecord | undefined> {
  const db = await getDB()
  const record = await db.get('highlights', id)
  if (!record) return undefined
  const next: HighlightRecord = { ...record, updatedAt: Date.now() }
  if (patch.color !== undefined) next.color = patch.color
  if (patch.style !== undefined) next.style = patch.style
  if (patch.note !== undefined) {
    const trimmed = patch.note.trim()
    if (trimmed) next.note = trimmed
    else delete next.note
  }
  await db.put('highlights', next)
  return next
}

/** 批量重定位（正文变更后修复锚点）。 */
export async function relocateHighlights(records: HighlightRecord[]): Promise<void> {
  const db = await getDB()
  const tx = db.transaction('highlights', 'readwrite')
  for (const r of records) await tx.objectStore('highlights').put(r)
  await tx.done
}

/** 某本书的全部划线，按位置升序；老记录在此统一归一化（不改库）。 */
export async function listHighlights(bookId: string): Promise<HighlightRecord[]> {
  const db = await getDB()
  const list = await db.getAllFromIndex('highlights', 'by-book', bookId)
  return list.map((r) => normalizeHighlight(r)).sort((a, b) => a.start - b.start)
}

export async function deleteHighlight(id: string): Promise<void> {
  const db = await getDB()
  await db.delete('highlights', id)
}

// ---------- 阅读统计（V2.0） ----------

function todayKey(now = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${m}-${d}`
}

/** 把本次会话累计的阅读分钟数并入今天的统计（页面可见时才计，后台挂机不计）。 */
export async function addReadingMinutes(minutes: number): Promise<void> {
  if (!(minutes > 0)) return
  const db = await getDB()
  const day = todayKey()
  const record = (await db.get('stats', day)) ?? { day, minutes: 0 }
  record.minutes = Math.round((record.minutes + minutes) * 10) / 10
  await db.put('stats', record)
}

export interface ReadingStats {
  todayMinutes: number
  weekMinutes: number
  totalMinutes: number
}

/** 今日 / 近 7 天 / 累计阅读分钟数。 */
export async function getReadingStats(now = new Date()): Promise<ReadingStats> {
  const db = await getDB()
  const all = await db.getAll('stats')
  const byDay = new Map(all.map((r) => [r.day, r.minutes]))
  const dayKeys = new Set(all.map((r) => r.day))
  const today = todayKey(now)
  let week = 0
  for (let i = 0; i < 7; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = todayKey(d)
    if (dayKeys.has(key)) week += byDay.get(key) ?? 0
  }
  const total = all.reduce((sum, r) => sum + r.minutes, 0)
  return {
    todayMinutes: byDay.get(today) ?? 0,
    weekMinutes: Math.round(week * 10) / 10,
    totalMinutes: Math.round(total * 10) / 10,
  }
}

// ---------- 书库管理（V2.0） ----------

/** 重命名书籍。 */
export async function renameBook(id: string, title: string): Promise<void> {
  const db = await getDB()
  const book = await db.get('books', id)
  if (!book) return
  const trimmed = title.trim()
  if (!trimmed) return
  book.title = trimmed
  await db.put('books', book)
}

// ---------- 备份与恢复（V2.0） ----------

export interface BackupData {
  app: 'xifeng-reader'
  version: 1
  exportedAt: number
  books: BookRecord[]
  progress: ProgressRecord[]
  bookmarks: BookmarkRecord[]
  stats: DayStatRecord[]
  highlights: HighlightRecord[]
  settings: unknown | null
}

/** 导出全量备份（含正文）。 */
export async function exportBackup(settings: unknown): Promise<BackupData> {
  const db = await getDB()
  return {
    app: 'xifeng-reader',
    version: 1,
    exportedAt: Date.now(),
    books: await db.getAll('books'),
    progress: await db.getAll('progress'),
    bookmarks: await db.getAll('bookmarks'),
    stats: await db.getAll('stats'),
    highlights: await db.getAll('highlights'),
    settings,
  }
}

export interface ImportReport {
  books: number
  progress: number
  bookmarks: number
  stats: number
  highlights: number
}

/** 导入备份（按 id 覆盖合并），返回各类记录的导入数量。 */
export async function importBackup(data: BackupData): Promise<ImportReport> {
  if (!data || data.app !== 'xifeng-reader' || !Array.isArray(data.books)) {
    throw new Error('不是有效的 xifeng 阅读备份文件')
  }
  const db = await getDB()
  const tx = db.transaction(['books', 'progress', 'bookmarks', 'stats', 'highlights'], 'readwrite')
  for (const b of data.books ?? []) await tx.objectStore('books').put(b)
  for (const p of data.progress ?? []) await tx.objectStore('progress').put(p)
  for (const b of data.bookmarks ?? []) {
    if (b && b.id && b.bookId != null) await tx.objectStore('bookmarks').put(b)
  }
  for (const s of data.stats ?? []) {
    if (s && s.day) await tx.objectStore('stats').put(s)
  }
  for (const h of data.highlights ?? []) {
    if (h && h.id && h.bookId != null) await tx.objectStore('highlights').put(h)
  }
  await tx.done
  return {
    books: data.books?.length ?? 0,
    progress: data.progress?.length ?? 0,
    bookmarks: data.bookmarks?.length ?? 0,
    stats: data.stats?.length ?? 0,
    highlights: data.highlights?.length ?? 0,
  }
}

/** 返回已保存的阅读位置（字符偏移）；没有记录时返回 null。 */
export async function getProgress(bookId: string): Promise<number | null> {
  const db = await getDB()
  const p = await db.get('progress', bookId)
  return p ? p.charIndex : null
}
