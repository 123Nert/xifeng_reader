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

import { openDB, type DBSchema, type IDBPDatabase, type IDBPObjectStore } from 'idb'
import type { BookFormat } from './importers/types'
import {
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_MARK_STYLE,
  normalizeHighlight,
  type HighlightColor,
  type HighlightRecord,
  type MarkStyle,
} from './highlight'
import { normalizeVocabRecord, reviewVocabRecord, type VocabRecord } from './vocabulary'

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
  /** V6.1：扫描版 PDF 标记 —— content= '', 位图存 pdfPages store，阅读页走图片模式 */
  scanned?: boolean
  /** V6.2：该 PDF 带原版页面位图（阅读页可显示"原来的样子"） */
  pdfOriginal?: boolean
  /** V6.2：原版页数（位图张数），书库按页显示进度 */
  pdfPageCount?: number
  /** V6.2：第 i 页文字在 content 中的起始偏移，页码 ↔ 字符偏移换算用（见 core/pdfNav.ts） */
  pdfPageStarts?: number[]
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
// V6.6：生词模型见 core/vocabulary.ts，此处再导出
export type { VocabRecord } from './vocabulary'


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
  /** V6.1：扫描版 PDF（位图存于 pdfPages，content 为空） */
  scanned?: boolean
  /** V6.2：该 PDF 带原版页面位图 */
  pdfOriginal?: boolean
  /** V6.2：原版页数（书库按页显示进度） */
  pdfPageCount?: number
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
  /** V6.1/V6.2：PDF 按页位图（旧记录：导入时已渲染好的页面）。 */
  pdfPages: { key: [string, number]; value: PdfPageRecord }
  /** V6.2：PDF 原始文件字节。存原件而不是预渲染位图：存储 ≈ 原文件大小，
   *  阅读时按需渲染，放大到多少倍都能重新按目标分辨率画（字迹不糊）。 */
  pdfFiles: { key: string; value: PdfFileRecord }
  /** V6.6：生词本。主键是归一化后的词（同词跨书唯一），by-book 索引做书内过滤。 */
  vocab: {
    key: string
    value: VocabRecord
    indexes: { 'by-book': string }
  }
}

/** V6.1 扫描版 PDF 一页的位图。key 用 [bookId, page] 展开，便于读当前页/全删/遍历。 */
export interface PdfPageRecord {
  bookId: string
  page: number
  width: number
  height: number
  /** dataURL（image/jpeg, 0.85），便于直接喂给 <img>。 */
  dataUrl: string
}

/** V6.2 PDF 原件：整份文件字节，阅读时按需渲染原版页。 */
export interface PdfFileRecord {
  bookId: string
  /** 原始 PDF 文件字节（含 xref/trailer，pdf.js 可直接解析） */
  bytes: ArrayBuffer
  /** 文件大小（字节），用于书库展示与存储占用提示 */
  size: number
}

const DB_NAME = 'xifeng-reader'
const DB_VERSION = 7

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
        if (oldVersion < 5) {
          // V6.1：扫描版 PDF 的位图按页存放。keyPath 用 [bookId, page] 复合键，
          // 便于按书快速清空；by-book 索引支持任意字符串 bookId。
          // 保留该 store：老库里的位图仍可读（新导入的 PDF 走 pdfFiles 原件通道）。
          const store = db.createObjectStore('pdfPages', { keyPath: ['bookId', 'page'] })
          ;(store as { createIndex(name: string, keyPath: string | string[]): unknown }).createIndex(
            'by-book',
            'bookId',
          )
        }
        if (oldVersion < 6) {
          // V6.2：PDF 原件（整份字节）。阅读时按需渲染原版页 ——
          // 存原件而非预渲染位图：占用 ≈ 原文件大小，放大后可重新高清渲染。
          db.createObjectStore('pdfFiles', { keyPath: 'bookId' })
        }
        if (oldVersion < 7) {
          // V6.6：生词本。主键 = 归一化后的词（同词唯一，浮卡可 O(1) 查收藏态），
          // by-book 索引做"当前这本书的生词"过滤与删书级联。
          const store = db.createObjectStore('vocab', { keyPath: 'word' })
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

/**
 * V6.2：保存一本书及其 PDF 原件（同一个事务，避免"书在、原件缺失"的半截状态）。
 * `book.pdfOriginal` 由本函数按实际存储结果写定（存不下就不标记），
 * 返回是否真的存了原件 —— 无原件的 PDF 只能显示文字视图。
 */
export async function addBookWithPdf(
  book: BookRecord,
  pdf: { bytes: ArrayBuffer; size: number } | null,
): Promise<boolean> {
  const db = await getDB()
  const tx = db.transaction(['books', 'pdfFiles'], 'readwrite')
  const hasOriginal = !!(pdf && pdf.bytes.byteLength > 0)
  const record: BookRecord = { ...book }
  if (hasOriginal) record.pdfOriginal = true
  else delete record.pdfOriginal
  await tx.objectStore('books').put(record)
  if (hasOriginal && pdf) {
    await tx.objectStore('pdfFiles').put({ bookId: book.id, bytes: pdf.bytes, size: pdf.size })
  } else {
    // 没带原件：清掉可能残留的旧原件，保持"记录与存储"一致
    await tx.objectStore('pdfFiles').delete(book.id)
  }
  await tx.done
  return hasOriginal
}

/** V6.2：取一本书的 PDF 原件字节；没有则 undefined。 */
export async function getPdfFile(bookId: string): Promise<ArrayBuffer | undefined> {
  const db = await getDB()
  const rec = await db.get('pdfFiles', bookId)
  return rec?.bytes
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
        scanned: b.scanned,
        pdfOriginal: b.pdfOriginal,
        pdfPageCount: b.pdfPageCount,
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
  const tx = db.transaction(['books', 'progress', 'pdfPages', 'pdfFiles', 'vocab', 'highlights'], 'readwrite')
  await Promise.all([
    tx.objectStore('books').delete(id),
    tx.objectStore('progress').delete(id),
    // 原版页/原件一并清掉，避免删书后 IndexedDB 还残留长尾存储
    deletePdfPagesFromStore(id, tx.objectStore('pdfPages') as IDBPObjectStore<XifengDB, ['pdfPages'], 'pdfPages', 'readwrite'>),
    tx.objectStore('pdfFiles').delete(id),
    deleteHighlightsFromStore(id, tx.objectStore('highlights')),
    deleteVocabFromStore(id, tx.objectStore('vocab')),
    tx.done,
  ])
}

/** 整本的原版页位图（按页码升序）。大文件慎用 —— 阅读页请用 getPdfPage 按页取。 */
export async function listPdfPages(bookId: string): Promise<PdfPageRecord[]> {
  const db = await getDB()
  // idb 在 composite keyPath（[bookId, page]）上对 index 查询的泛型推断有问题，绕开它即可
  const store = db.transaction('pdfPages').store
  const list = await (store as unknown as {
    index(name: 'by-book'): { getAll(query: IDBValidKey): Promise<PdfPageRecord[]> }
  })
    .index('by-book')
    .getAll(bookId)
  return list.sort((a, b) => a.page - b.page)
}

/**
 * 取一本书某一页的原版位图（0-based 页号）。
 * 按页读而非整本读：几十 MB 的位图整本放进内存会同时压垮内存与首帧 ——
 * 阅读页只留当前页 + 相邻页的预热缓存。
 */
export async function getPdfPage(bookId: string, page: number): Promise<PdfPageRecord | undefined> {
  const db = await getDB()
  const tx = db.transaction('pdfPages')
  // 复合主键 [bookId, page]，直接用主键 get，无需走索引
  return await tx.store.get([bookId, page])
}

/** 写入整本原版页位图（清空旧的后再写），由导入器调用。 */
export async function setPdfPages(
  bookId: string,
  pages: Array<Omit<PdfPageRecord, 'bookId'>>,
): Promise<void> {
  const db = await getDB()
  const tx = db.transaction('pdfPages', 'readwrite')
  await deletePdfPagesFromStore(bookId, tx.objectStore('pdfPages'))
  for (const p of pages) {
    await tx.objectStore('pdfPages').put({ ...p, bookId })
  }
  await tx.done
}

/** 删除某本书的全部原版页位图。 */
export async function deletePdfPages(bookId: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction('pdfPages', 'readwrite')
  await deletePdfPagesFromStore(bookId, tx.objectStore('pdfPages'))
  await tx.done
}

async function deletePdfPagesFromStore(
  bookId: string,
  store: IDBPObjectStore<XifengDB, ['pdfPages'], 'pdfPages', 'readwrite'>,
): Promise<void> {
  const idx = store.index('by-book' as never)
  const keys = await idx.getAllKeys(IDBKeyRange.only(bookId) as never)
  for (const k of keys) await store.delete(k)
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

// ---------- 生词本（V6.6） ----------

/** 写入/覆盖一条生词（同词主键覆盖；重复收藏的 lookups 合并由调用方先算好）。 */
export async function addVocabRecord(record: VocabRecord): Promise<VocabRecord> {
  const db = await getDB()
  const normalized = normalizeVocabRecord(record)
  await db.put('vocab', normalized)
  return normalized
}

/** 查某个词收过没有（浮卡打开时的"已收藏"态）。 */
export async function getVocabRecord(word: string): Promise<VocabRecord | undefined> {
  const db = await getDB()
  return db.get('vocab', word)
}

/** 某本书的生词，按最近收藏时间倒序（阅读菜单「生词」页签）。 */
export async function listVocabByBook(bookId: string): Promise<VocabRecord[]> {
  const db = await getDB()
  const list = (await db.getAll('vocab')).map(normalizeVocabRecord)
  return list
    .filter((record) => record.sources?.some((source) => source.bookId === bookId))
    .sort((a, b) => b.lastLookupAt - a.lastLookupAt)
}

/** 全量生词，按最近收藏时间倒序（导出用）。 */
export async function listVocabAll(): Promise<VocabRecord[]> {
  const db = await getDB()
  const list = (await db.getAll('vocab')).map(normalizeVocabRecord)
  return list.sort((a, b) => b.lastLookupAt - a.lastLookupAt)
}

export async function reviewVocab(
  word: string,
  remembered: boolean,
  now = Date.now(),
): Promise<VocabRecord | undefined> {
  const db = await getDB()
  const tx = db.transaction('vocab', 'readwrite')
  const store = tx.objectStore('vocab')
  const record = await store.get(word)
  if (!record) {
    await tx.done
    return undefined
  }
  const reviewed = reviewVocabRecord(record, remembered, now)
  await store.put(reviewed)
  await tx.done
  return reviewed
}

export async function deleteVocabRecord(word: string): Promise<void> {
  const db = await getDB()
  await db.delete('vocab', word)
}

/** 删除某本书的全部生词（deleteBook 级联用）。 */
export async function deleteVocabByBook(bookId: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction('vocab', 'readwrite')
  await deleteVocabFromStore(bookId, tx.objectStore('vocab'))
  await tx.done
}

async function deleteVocabFromStore(
  bookId: string,
  store: IDBPObjectStore<XifengDB, any, 'vocab', 'readwrite'>,
): Promise<void> {
  const records = await store.getAll()
  for (const record of records) {
    const normalized = normalizeVocabRecord(record)
    const existingSources = normalized.sources ?? []
    const sources = existingSources.filter((source) => source.bookId !== bookId)
    if (sources.length === existingSources.length) continue
    if (sources.length === 0) {
      await store.delete(record.word)
      continue
    }
    const next: VocabRecord = { ...normalized, sources }
    if (normalized.bookId === bookId) {
      const latest = sources[sources.length - 1]
      next.bookId = latest.bookId
      next.charIndex = latest.charIndex
      next.excerpt = latest.excerpt
      next.gloss = latest.gloss ?? normalized.gloss
      if (latest.alt) next.alt = latest.alt
      else delete next.alt
      if (latest.context) next.context = latest.context
      else delete next.context
    }
    await store.put(next)
  }
}

async function deleteHighlightsFromStore(
  bookId: string,
  store: IDBPObjectStore<XifengDB, any, 'highlights', 'readwrite'>,
): Promise<void> {
  const keys = await store.index('by-book').getAllKeys(IDBKeyRange.only(bookId))
  for (const key of keys) await store.delete(key)
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

export async function listHighlightsAll(): Promise<HighlightRecord[]> {
  const db = await getDB()
  const list = await db.getAll('highlights')
  return list.map(normalizeHighlight).sort((a, b) => b.createdAt - a.createdAt)
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

/**
 * V6.3：写入/清除书籍封面（书架卡片显示"这本书的第一页"）。
 * 只改封面字段，不动其它属性；传 null 表示清除（回退渐变色块）。
 */
export async function setBookCover(id: string, cover: string | null): Promise<void> {
  const db = await getDB()
  const book = await db.get('books', id)
  if (!book) return
  if (cover) book.cover = cover
  else delete book.cover
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
  /** V6.6：生词本（缺省 = 老备份，照常导入） */
  vocab?: VocabRecord[]
  /** V6.3：PDF 原件（base64）。缺省表示这份备份不含原件，导入后 PDF 只能看文字。 */
  pdfFiles?: Array<{ bookId: string; bytes: string; size: number }>
}

/** 导出全量备份（含正文；PDF 原件以 base64 一并带上）。 */
export async function exportBackup(settings: unknown): Promise<BackupData> {
  const db = await getDB()
  const files = await db.getAll('pdfFiles')
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
    vocab: await db.getAll('vocab'),
    pdfFiles: files.map((f) => ({
      bookId: f.bookId,
      bytes: encodeBytesToBase64(f.bytes),
      size: f.size,
    })),
  }
}

export interface ImportReport {
  books: number
  progress: number
  bookmarks: number
  stats: number
  highlights: number
  vocab: number
  pdfFiles: number
}

/** 导入备份（按 id 覆盖合并），返回各类记录的导入数量。 */
export async function importBackup(data: BackupData): Promise<ImportReport> {
  if (!data || data.app !== 'xifeng-reader' || !Array.isArray(data.books)) {
    throw new Error('不是有效的 xifeng 阅读备份文件')
  }
  const db = await getDB()
  const tx = db.transaction(
    ['books', 'progress', 'bookmarks', 'stats', 'highlights', 'pdfFiles', 'vocab'],
    'readwrite',
  )
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
  // V6.6：生词随备份走（主键=词，覆盖合并）。老备份没有该字段不算错误。
  for (const v of data.vocab ?? []) {
    if (v && v.word && v.bookId != null) await tx.objectStore('vocab').put(v)
  }
  // V6.3：PDF 原件随备份走（base64 字符串 → 还原成 ArrayBuffer）。
  // 老备份没有该字段，或某本书没带原件 —— 都不算错误，只是那本仍需重新导入。
  let pdfFiles = 0
  for (const p of data.pdfFiles ?? []) {
    const bytes = decodeBase64ToBytes(p?.bytes)
    if (!p || !p.bookId || !bytes) continue
    await tx.objectStore('pdfFiles').put({ bookId: p.bookId, bytes, size: p.size ?? bytes.byteLength })
    pdfFiles++
  }
  await tx.done
  return {
    books: data.books?.length ?? 0,
    progress: data.progress?.length ?? 0,
    bookmarks: data.bookmarks?.length ?? 0,
    stats: data.stats?.length ?? 0,
    highlights: data.highlights?.length ?? 0,
    vocab: data.vocab?.length ?? 0,
    pdfFiles,
  }
}

/** base64 → ArrayBuffer（备份里的 PDF 原件）。非法输入返回 null。 */
function decodeBase64ToBytes(b64: unknown): ArrayBuffer | null {
  if (typeof b64 !== 'string' || !b64) return null
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out.buffer
  } catch {
    return null
  }
}

/** ArrayBuffer → base64（导出备份时用）。 */
function encodeBytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  // 分块拼接：一次 apply 百万级参数会爆栈
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** 返回已保存的阅读位置（字符偏移）；没有记录时返回 null。 */
export async function getProgress(bookId: string): Promise<number | null> {
  const db = await getDB()
  const p = await db.get('progress', bookId)
  return p ? p.charIndex : null
}
