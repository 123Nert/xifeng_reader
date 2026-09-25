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
}

interface XifengDB extends DBSchema {
  books: { key: string; value: BookRecord }
  progress: { key: string; value: ProgressRecord }
  bookmarks: {
    key: string
    value: BookmarkRecord
    indexes: { 'by-book': string }
  }
}

const DB_NAME = 'xifeng-reader'
const DB_VERSION = 2

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

/** 返回已保存的阅读位置（字符偏移）；没有记录时返回 null。 */
export async function getProgress(bookId: string): Promise<number | null> {
  const db = await getDB()
  const p = await db.get('progress', bookId)
  return p ? p.charIndex : null
}
