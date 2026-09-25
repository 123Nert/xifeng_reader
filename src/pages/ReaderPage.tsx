/**
 * ReaderPage.tsx — 阅读页（技术方案 §2/§3.3/§3.4）。
 * 只渲染当前页切片；翻页 / 跳转 / 锚定重排全部委托 core 层 PageMap。
 * 顶栏与底栏为悬浮层：显隐不改变正文区尺寸，避免无谓重排。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { PageMap, type Measurer } from '../core/pagination'
import { buildToc, currentChapterIndex, type Toc } from '../core/toc'
import { searchText } from '../core/search'
import {
  addBookmark,
  deleteBookmark,
  getBook,
  getProgress,
  listBookmarks,
  saveProgress,
  updateBookTocPattern,
  type BookmarkRecord,
} from '../core/bookRepository'
import {
  applySettingsToDocument,
  clampFontSize,
  loadSettings,
  nextLineHeight,
  saveSettings,
  FONT_STEP,
  type ReaderSettings,
  type ThemeName,
} from '../core/settings'
import ReaderMenu, { type MenuTab } from './ReaderMenu'

/**
 * DOM 版 Measurer：离屏探针与正文同宽、同一组 CSS 变量排版，"所见即所测"。
 * refresh() 在窗口尺寸 / 阅读设置变化后调用，丢弃缓存的页高与容量估算。
 */
function createDomMeasurer(
  text: string,
  viewport: HTMLElement,
  probe: HTMLElement,
): Measurer & { refresh(): void } {
  let pageHeight = viewport.clientHeight
  let capacity = 0

  return {
    refresh() {
      pageHeight = viewport.clientHeight
      capacity = 0
    },
    estimateCapacity(): number {
      if (capacity > 0) return capacity
      const style = getComputedStyle(probe)
      // 用 nowrap 的内联 span 实测全角字符宽（探针本身会折行，不能直接量）
      const span = document.createElement('span')
      span.textContent = '一二三四五六七八九十'
      span.style.whiteSpace = 'nowrap'
      probe.replaceChildren(span)
      const charWidth = span.getBoundingClientRect().width / 10 || 1
      const contentWidth =
        probe.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.75 || 24
      const linesPerPage = Math.max(1, Math.floor(pageHeight / lineHeight))
      capacity = Math.max(1, Math.floor(contentWidth / charWidth) * linesPerPage)
      return capacity
    },
    fits(start: number, n: number): boolean {
      // 页尾换行不占当前页高度（渲染时是裁剪区内的空行），页界可以免费含住它们
      const slice = text.slice(start, start + n).replace(/[\r\n]+$/, '')
      probe.textContent = slice
      return probe.offsetHeight <= pageHeight
    },
  }
}

export default function ReaderPage({ bookId, onBack }: { bookId: string; onBack: () => void }) {
  const [title, setTitle] = useState('')
  const [totalChars, setTotalChars] = useState(0)
  const [page, setPage] = useState({ start: 0, end: 0 })
  const [chromeVisible, setChromeVisible] = useState(true)
  const [settings, setSettings] = useState<ReaderSettings>(() => loadSettings())
  const [ready, setReady] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [toc, setToc] = useState<Toc>({ entries: [], source: 'none' })
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuTab, setMenuTab] = useState<MenuTab>('toc')
  const [patternDraft, setPatternDraft] = useState('')
  const [bookmarks, setBookmarks] = useState<BookmarkRecord[]>([])
  const [hlQuery, setHlQuery] = useState<string | null>(null)

  const textRef = useRef('')
  const pagemapRef = useRef<PageMap | null>(null)
  const measurerRef = useRef<(Measurer & { refresh(): void }) | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 1600)
  }, [])

  // ---- 初始化：加载正文与进度，建立 Measurer + PageMap，续读定位 ----
  useEffect(() => {
    let cancelled = false
    setReady(false)
    void (async () => {
      const book = await getBook(bookId)
      if (!book) {
        onBack()
        return
      }
      if (cancelled) return
      applySettingsToDocument(loadSettings())
      const viewport = viewportRef.current
      const probe = probeRef.current
      if (!viewport || !probe) return

      textRef.current = book.content
      const measurer = createDomMeasurer(book.content, viewport, probe)
      const pm = new PageMap(book.content, measurer)
      const saved = await getProgress(bookId)
      if (cancelled) return
      if (saved != null && saved > 0) pm.jumpTo(saved)
      pagemapRef.current = pm
      measurerRef.current = measurer
      setTitle(book.title)
      setTotalChars(pm.totalChars)
      setPage({ ...pm.current })
      setToc(buildToc(book.content, book.tocPattern))
      setPatternDraft(book.tocPattern ?? '')
      setBookmarks(await listBookmarks(bookId))
      setReady(true)
      // 打开即记一次"最后阅读时间"
      void saveProgress(bookId, pm.current.start)
    })()
    return () => {
      cancelled = true
    }
  }, [bookId, onBack])

  // ---- 翻页 / 跳转（每次落位即写进度，写入量极小） ----
  const turn = useCallback(
    (dir: -1 | 1) => {
      const pm = pagemapRef.current
      if (!pm) return
      const ok = dir === 1 ? pm.goNext() : pm.goPrev()
      if (!ok) {
        showToast(dir === 1 ? '已经是最后一页了' : '已经是第一页')
        return
      }
      setPage({ ...pm.current })
      void saveProgress(bookId, pm.current.start)
    },
    [bookId, showToast],
  )

  const jumpToFraction = useCallback(
    (fraction: number) => {
      const pm = pagemapRef.current
      if (!pm || pm.totalChars === 0) return
      const target = Math.round(fraction * (pm.totalChars - 1))
      pm.jumpTo(target)
      setPage({ ...pm.current })
      void saveProgress(bookId, pm.current.start)
    },
    [bookId],
  )

  /**
   * 进度条拖动：input 事件里直接跳转。单次跳转只是一次实测二分（毫秒级），
   * 无需 rAF 节流——后台页面里 rAF/定时器都会被浏览器暂停或钳制，直接执行反而最可靠。
   */
  const onSliderInput = useCallback(
    (fraction: number) => {
      jumpToFraction(fraction)
    },
    [jumpToFraction],
  )

  // ---- 阅读设置：写回 CSS 变量并锚定重排，阅读位置不丢（验收标准 5） ----
  const commitSettings = useCallback((next: ReaderSettings) => {
    setSettings(next)
    saveSettings(next)
    applySettingsToDocument(next)
    const pm = pagemapRef.current
    if (!pm) return
    measurerRef.current?.refresh()
    setPage({ ...pm.reflow() })
  }, [])

  const changeFont = useCallback(
    (delta: -1 | 1) => {
      const next = { ...settings, fontSize: clampFontSize(settings.fontSize + delta * FONT_STEP) }
      commitSettings(next)
      showToast(`字号 ${next.fontSize}`)
    },
    [settings, commitSettings, showToast],
  )

  const cycleLineHeight = useCallback(() => {
    const next = { ...settings, lineHeight: nextLineHeight(settings.lineHeight) }
    commitSettings(next)
    showToast(`行距 ${next.lineHeight}`)
  }, [settings, commitSettings, showToast])

  /** 主题只切换颜色不改版式，无需分页重排。 */
  const setThemeNamed = useCallback(
    (theme: ThemeName) => {
      const next = { ...settings, theme }
      setSettings(next)
      saveSettings(next)
      applySettingsToDocument(next)
    },
    [settings],
  )

  /** 目录 / 书签 / 搜索统一跳转：与进度条共用 PageMap.jumpTo，同一字符偏移坐标系。 */
  const jumpToOffset = useCallback(
    (charIndex: number) => {
      const pm = pagemapRef.current
      if (!pm) return
      pm.jumpTo(charIndex)
      setPage({ ...pm.current })
      void saveProgress(bookId, pm.current.start)
      setMenuOpen(false)
    },
    [bookId],
  )

  const openMenu = useCallback((tab: MenuTab) => {
    setMenuTab(tab)
    setMenuOpen(true)
  }, [])

  const handleAddBookmark = useCallback(async () => {
    const pm = pagemapRef.current
    if (!pm) return
    const excerpt = textRef.current
      .slice(pm.current.start, pm.current.start + 48)
      .replace(/\s+/g, ' ')
      .trim()
    await addBookmark(bookId, pm.current.start, excerpt)
    setBookmarks(await listBookmarks(bookId))
    showToast('已添加书签')
  }, [bookId, showToast])

  const handleDeleteBookmark = useCallback(
    async (id: string) => {
      await deleteBookmark(id)
      setBookmarks(await listBookmarks(bookId))
      showToast('已删除书签')
    },
    [bookId, showToast],
  )

  /** 全文搜索：结果交给菜单展示，同时记住关键词用于正文页内高亮。 */
  const handleSearch = useCallback((query: string) => {
    setHlQuery(query.trim() || null)
    return searchText(textRef.current, query)
  }, [])

  /** 应用自定义章节正则（保存到书籍记录，空串恢复内置模式）。 */
  const applyPattern = useCallback(async () => {
    const t = buildToc(textRef.current, patternDraft)
    if (t.error) {
      setToc(t)
      return
    }
    await updateBookTocPattern(bookId, patternDraft)
    setToc(t)
    showToast(t.entries.length > 0 ? `已识别 ${t.entries.length} 章` : '未识别到章节')
  }, [patternDraft, bookId, showToast])

  // ---- 键盘：←/→、PageUp/PageDown、空格翻页，Esc 返回书库 ----
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        turn(1)
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        turn(-1)
      } else if (e.key === 'Escape') {
        if (menuOpen) setMenuOpen(false)
        else onBack()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [turn, onBack, menuOpen])

  // ---- 窗口尺寸变化：去抖后刷新度量并锚定重排 ----
  useEffect(() => {
    let debounce = 0
    const onResize = () => {
      window.clearTimeout(debounce)
      debounce = window.setTimeout(() => {
        const pm = pagemapRef.current
        if (!pm) return
        measurerRef.current?.refresh()
        setPage({ ...pm.reflow() })
      }, 250)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.clearTimeout(debounce)
    }
  }, [])

  const percent = totalChars > 1 ? (page.end >= totalChars ? 1 : page.start / (totalChars - 1)) : 0
  const pageText = ready ? textRef.current.slice(page.start, page.end) : ''
  const chapterIdx = toc.entries.length > 0 ? currentChapterIndex(toc.entries, page.start) : -1
  const chapterTitle = chapterIdx >= 0 ? toc.entries[chapterIdx].title : null

  /** 正文渲染：搜索关键词命中处在当前页内高亮。 */
  const renderContent = (): ReactNode => {
    if (!pageText) return ready && totalChars === 0 ? '（这本书没有正文内容）' : ''
    const q = hlQuery?.trim().toLowerCase()
    if (!q) return pageText
    const lower = pageText.toLowerCase()
    if (!lower.includes(q)) return pageText
    const parts: ReactNode[] = []
    let i = 0
    let k = 0
    for (;;) {
      const idx = lower.indexOf(q, i)
      if (idx < 0) {
        parts.push(pageText.slice(i))
        break
      }
      parts.push(pageText.slice(i, idx))
      parts.push(<mark key={k++}>{pageText.slice(idx, idx + q.length)}</mark>)
      i = idx + q.length
    }
    return parts
  }

  return (
    <section className={`reader${chromeVisible ? '' : ' chrome-hidden'}`}>
      <header className="reader-bar reader-top">
        <button className="btn ghost" onClick={onBack}>
          ‹ 书库
        </button>
        <div className="reader-title">
          <span className="reader-book">{title}</span>
          {chapterTitle && <span className="reader-chapter">{chapterTitle}</span>}
        </div>
        <div className="top-spacer" />
      </header>

      <main ref={viewportRef} className="page-viewport">
        <div className="page-content" aria-live="polite">
          {renderContent()}
        </div>
        {/* 离屏测量探针：与正文同宽同样式，仅用于分页测量 */}
        <div ref={probeRef} className="page-probe" aria-hidden="true" />
        <div className="tap-zone left" title="上一页（←）" onClick={() => turn(-1)} />
        <div
          className="tap-zone center"
          title="显示 / 隐藏工具栏"
          onClick={() => setChromeVisible((v) => !v)}
        />
        <div className="tap-zone right" title="下一页（→）" onClick={() => turn(1)} />
        {!ready && <div className="reader-loading">打开中…</div>}
      </main>

      <footer className="reader-bar reader-bottom">
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(percent * 1000)}
          step={1}
          aria-label="阅读进度，拖动跳转"
          disabled={totalChars <= 1}
          onChange={(e) => onSliderInput(Number(e.target.value) / 1000)}
        />
        <div className="bottom-row">
          <span className="page-info">{Math.round(percent * 100)}%</span>
          <div className="menu-buttons">
            <button className="btn chip" onClick={() => openMenu('toc')}>
              目录
            </button>
            <button className="btn chip" onClick={() => openMenu('marks')}>
              书签
            </button>
            <button className="btn chip" onClick={() => openMenu('search')}>
              搜索
            </button>
            <button className="btn chip" onClick={() => openMenu('settings')}>
              设置
            </button>
          </div>
        </div>
      </footer>

      {/* 阅读菜单（V1.2）：目录 / 书签 / 搜索 / 设置 */}
      <ReaderMenu
        open={menuOpen}
        tab={menuTab}
        onTabChange={setMenuTab}
        onClose={() => setMenuOpen(false)}
        toc={toc}
        chapterIdx={chapterIdx}
        totalChars={totalChars}
        patternDraft={patternDraft}
        onPatternDraft={setPatternDraft}
        onApplyPattern={() => void applyPattern()}
        bookmarks={bookmarks}
        onAddBookmark={() => void handleAddBookmark()}
        onDeleteBookmark={(id) => void handleDeleteBookmark(id)}
        onJumpOffset={jumpToOffset}
        onSearch={handleSearch}
        settings={settings}
        onFontDelta={changeFont}
        onLineHeight={cycleLineHeight}
        onTheme={setThemeNamed}
      />

      {toast && <div className="toast">{toast}</div>}
    </section>
  )
}
