/**
 * ReaderPage.tsx — 阅读页（技术方案 §2/§3.3/§3.4）。
 * 只渲染当前页切片；翻页 / 跳转 / 锚定重排全部委托 core 层 PageMap。
 * 顶栏与底栏为悬浮层：显隐不改变正文区尺寸，避免无谓重排。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { PageMap, type Measurer } from '../core/pagination'
import { buildToc, currentChapterIndex, type Toc, type TocEntry } from '../core/toc'
import { getBook, getProgress, saveProgress, updateBookTocPattern } from '../core/bookRepository'
import {
  applySettingsToDocument,
  clampFontSize,
  loadSettings,
  nextLineHeight,
  nextTheme,
  saveSettings,
  FONT_STEP,
  THEME_LABELS,
  type ReaderSettings,
} from '../core/settings'

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
  const [tocOpen, setTocOpen] = useState(false)
  const [patternDraft, setPatternDraft] = useState('')

  const textRef = useRef('')
  const pagemapRef = useRef<PageMap | null>(null)
  const measurerRef = useRef<(Measurer & { refresh(): void }) | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const pendingFraction = useRef<number | null>(null)
  const rafPending = useRef(false)

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

  /** 进度条拖动：input 事件高频触发，用 rAF 合并到每帧最多一次跳转。 */
  const onSliderInput = useCallback(
    (fraction: number) => {
      pendingFraction.current = fraction
      if (rafPending.current) return
      rafPending.current = true
      requestAnimationFrame(() => {
        rafPending.current = false
        const f = pendingFraction.current
        pendingFraction.current = null
        if (f != null) jumpToFraction(f)
      })
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
  const cycleTheme = useCallback(() => {
    const next = { ...settings, theme: nextTheme(settings.theme) }
    setSettings(next)
    saveSettings(next)
    applySettingsToDocument(next)
    showToast(`主题 ${THEME_LABELS[next.theme]}`)
  }, [settings, showToast])

  /** 目录跳转：与进度条共用 PageMap.jumpTo，同一字符偏移坐标系。 */
  const jumpToChapter = useCallback(
    (entry: TocEntry) => {
      const pm = pagemapRef.current
      if (!pm) return
      pm.jumpTo(entry.charIndex)
      setPage({ ...pm.current })
      void saveProgress(bookId, pm.current.start)
      setTocOpen(false)
    },
    [bookId],
  )

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
        onBack()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [turn, onBack])

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

  // 打开目录时把当前章节滚到可见区域中央
  useEffect(() => {
    if (!tocOpen) return
    document.querySelector('.toc-item.active')?.scrollIntoView({ block: 'center' })
  }, [tocOpen, chapterIdx])

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
        <div className="top-actions">
          {toc.entries.length > 0 && (
            <button className="btn ghost" onClick={() => setTocOpen(true)}>
              目录
            </button>
          )}
        </div>
        <div className="top-spacer" />
      </header>

      <main ref={viewportRef} className="page-viewport">
        <div className="page-content" aria-live="polite">
          {pageText || (ready && totalChars === 0 ? '（这本书没有正文内容）' : '')}
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
          <div className="font-controls">
            <button className="btn chip" title="减小字号" onClick={() => changeFont(-1)}>
              A−
            </button>
            <button className="btn chip" title="增大字号" onClick={() => changeFont(1)}>
              A＋
            </button>
            <button className="btn chip" title="切换行距" onClick={cycleLineHeight}>
              行距 {settings.lineHeight}
            </button>
            <button className="btn chip" title="切换主题（日间/护眼/夜间）" onClick={cycleTheme}>
              主题 {THEME_LABELS[settings.theme]}
            </button>
          </div>
        </div>
      </footer>

      {/* 目录抽屉（V1.1） */}
      {tocOpen && (
        <div className="toc-mask" onClick={() => setTocOpen(false)}>
          <aside className="toc-drawer" onClick={(e) => e.stopPropagation()}>
            <header className="toc-header">
              <span>目录</span>
              <span className="toc-count">
                {toc.source === 'custom' ? '自定义正则 · ' : ''}
                {toc.entries.length} 章
              </span>
              <button className="btn ghost" onClick={() => setTocOpen(false)}>
                关闭
              </button>
            </header>
            <div className="toc-list">
              {toc.entries.map((entry, i) => (
                <button
                  key={entry.charIndex}
                  className={`toc-item${i === chapterIdx ? ' active' : ''}`}
                  onClick={() => jumpToChapter(entry)}
                >
                  <span className="toc-name">{entry.title}</span>
                  <span className="toc-percent">
                    {totalChars > 1
                      ? Math.round((entry.charIndex / (totalChars - 1)) * 100) + '%'
                      : ''}
                  </span>
                </button>
              ))}
            </div>
            <footer className="toc-footer">
              <input
                className="toc-pattern-input"
                value={patternDraft}
                placeholder="自定义章节正则（可选，如 ^\\d+$）"
                onChange={(e) => setPatternDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void applyPattern()
                }}
              />
              <button className="btn chip" onClick={() => void applyPattern()}>
                应用
              </button>
              {toc.error && <div className="toc-error">{toc.error}</div>}
            </footer>
          </aside>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </section>
  )
}
