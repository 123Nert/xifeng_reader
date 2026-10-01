import { useEffect, useMemo, useState } from 'react'
import {
  getBook,
  listHighlightsAll,
  listLibrary,
  listVocabAll,
  reviewVocab,
  type LibraryEntry,
} from '../core/bookRepository'
import {
  buildStudyMaterials,
  filterStudyMaterials,
  studyMaterialsToCsv,
  studyMaterialsToMarkdown,
  type StudyMaterial,
  type StudyMaterialType,
} from '../core/studyMaterials'

interface Props {
  onBack: () => void
  onOpenReader: (bookId: string, charIndex: number) => void
}

function downloadFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

function dueLabel(item: StudyMaterial, now: number): string {
  if (item.dueAt == null || item.dueAt <= now) return '待复习'
  return `下次：${new Date(item.dueAt).toLocaleDateString()}`
}

export default function StudyMaterialsPage({ onBack, onOpenReader }: Props) {
  const [library, setLibrary] = useState<LibraryEntry[]>([])
  const [items, setItems] = useState<StudyMaterial[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [bookId, setBookId] = useState('all')
  const [chapter, setChapter] = useState('all')
  const [type, setType] = useState<StudyMaterialType | 'all'>('all')
  const [query, setQuery] = useState('')
  const [dueOnly, setDueOnly] = useState(false)
  const [now, setNow] = useState(Date.now())

  async function refresh() {
    setLoading(true)
    setError('')
    try {
      const [books, highlights, vocabulary] = await Promise.all([
        listLibrary(), listHighlightsAll(), listVocabAll(),
      ])
      const fullBooks = await Promise.all(books.map((book) => getBook(book.id)))
      setLibrary(books)
      setItems(buildStudyMaterials(
        fullBooks.flatMap((book) => book ? [{
          id: book.id,
          title: book.title,
          content: book.content,
          tocPattern: book.tocPattern,
          tocEntries: book.tocEntries,
        }] : []),
        highlights,
        vocabulary,
      ))
    } catch {
      setError('学习资料加载失败，请刷新后重试。')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  const chapters = useMemo(() => {
    const seen = new Map<number, string>()
    for (const item of items) {
      if ((bookId === 'all' || item.bookId === bookId) && item.chapterIndex != null && item.chapterTitle) {
        seen.set(item.chapterIndex, item.chapterTitle)
      }
    }
    return [...seen.entries()].sort((a, b) => a[0] - b[0])
  }, [bookId, items])

  const visible = useMemo(() => filterStudyMaterials(items, {
    bookId,
    chapterIndex: chapter === 'all' ? 'all' : Number(chapter),
    type,
    query,
    dueOnly,
    now,
  }), [bookId, chapter, dueOnly, items, now, query, type])

  async function review(item: StudyMaterial, remembered: boolean) {
    if (!item.word) return
    await reviewVocab(item.word, remembered)
    setNow(Date.now())
    await refresh()
  }

  const selectedBook = library.find((book) => book.id === bookId)
  const exportBase = (selectedBook?.title ?? '学习资料').replace(/[\\/:*?"<>|]/g, '_')

  return (
    <section className="study-page">
      <header className="study-header">
        <button className="btn chip" onClick={onBack}>返回书库</button>
        <div>
          <h1>学习资料</h1>
          <p className="sub">按书籍和章节整理批注、生词；复习进度保存在本机。</p>
        </div>
        <div className="study-export-actions">
          <button className="btn chip" disabled={!visible.length} onClick={() => downloadFile(
            `${exportBase}-学习资料.md`, studyMaterialsToMarkdown(visible), 'text/markdown;charset=utf-8',
          )}>导出 Markdown</button>
          <button className="btn chip" disabled={!visible.length} onClick={() => downloadFile(
            `${exportBase}-学习资料.csv`, studyMaterialsToCsv(visible), 'text/csv;charset=utf-8',
          )}>导出 CSV</button>
        </div>
      </header>

      <div className="study-toolbar">
        <input className="search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索原文、笔记、生词或释义" />
        <select className="import-select" value={bookId} onChange={(event) => { setBookId(event.target.value); setChapter('all') }}>
          <option value="all">全部书籍</option>
          {library.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}
        </select>
        <select className="import-select" value={chapter} onChange={(event) => setChapter(event.target.value)}>
          <option value="all">全部章节</option>
          {chapters.map(([index, title]) => <option key={index} value={index}>{title}</option>)}
        </select>
        <select className="import-select" value={type} onChange={(event) => setType(event.target.value as StudyMaterialType | 'all')}>
          <option value="all">全部类型</option>
          <option value="highlight">批注与笔记</option>
          <option value="vocab">生词</option>
        </select>
        <label className="study-due-toggle"><input type="checkbox" checked={dueOnly} onChange={(event) => setDueOnly(event.target.checked)} />只看待复习</label>
        <span className="study-count">显示 {visible.length} / {items.length} 条</span>
      </div>

      {error && <div className="empty"><p className="empty-title">{error}</p><button className="btn chip" onClick={() => void refresh()}>重试</button></div>}
      {loading && <div className="empty"><p className="empty-title">正在整理学习资料…</p></div>}
      {!loading && !error && visible.length === 0 && <div className="empty"><p className="empty-title">没有匹配的学习资料</p><p className="sub">调整搜索词或筛选条件试试。</p></div>}

      {!loading && visible.length > 0 && <main className="study-list">
        {visible.map((item) => <article className="study-card" key={item.id}>
          <div className="study-card-top">
            <span className={`study-kind ${item.type}`}>{item.type === 'highlight' ? '批注' : '生词'}</span>
            <span>{item.bookTitle}{item.chapterTitle ? ` · ${item.chapterTitle}` : ''}</span>
            <span className="flex-spacer" />
            {item.type === 'vocab' && <span className="study-due">{dueLabel(item, now)}</span>}
            <button className="btn chip" onClick={() => onOpenReader(item.bookId, item.charIndex)}>回到原文</button>
          </div>
          {item.type === 'highlight' ? <>
            <p className="study-quote">{item.text}</p>
            {item.note && <p className="study-note">{item.note}</p>}
          </> : <>
            <h2 className="study-word">{item.word}<span>{item.gloss}</span></h2>
            {item.context && <p className="study-note">{item.context}</p>}
            {item.text && <p className="study-quote">{item.text}</p>}
            <div className="study-review-actions">
              <button className="btn chip" onClick={() => void review(item, false)}>再复习（明天）</button>
              <button className="btn chip primary" onClick={() => void review(item, true)}>记住了</button>
            </div>
          </>}
        </article>)}
      </main>}
    </section>
  )
}