/**
 * ReaderPage.tsx — 阅读页（技术方案 §2/§3.3/§3.4）。
 * 只渲染当前页切片；翻页 / 跳转 / 锚定重排全部委托 core 层 PageMap。
 * 顶栏与底栏为悬浮层：显隐不改变正文区尺寸，避免无谓重排。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PageMap, type Measurer, type Page } from '../core/pagination'
import { buildToc, currentChapterIndex, type Toc } from '../core/toc'
import { searchText } from '../core/search'
import {
  addBookmark,
  addHighlight,
  addReadingMinutes,
  deleteBookmark,
  deleteHighlight,
  getBook,
  getProgress,
  listBookmarks,
  listHighlights,
  saveProgress,
  updateBookTocPattern,
  type BookmarkRecord,
  type HighlightRecord,
} from '../core/bookRepository'
import {
  applySettingsToDocument,
  clampFontSize,
  loadSettings,
  nextLineHeight,
  nextMargin,
  nextParaSpacing,
  saveSettings,
  FONT_STEP,
  type ReaderSettings,
  type ThemeName,
} from '../core/settings'
import ReaderMenu, { type MenuTab } from './ReaderMenu'

/**
 * 按行切段：与正文渲染共用同一规则（V1.3 排版基础）。
 * 每个非空行渲染为一个段落块，段距/缩进/对齐由 CSS 变量控制；
 * 空行不渲染（视觉间隔由段距承担），探针与正文结构一致保证"所见即所测"。
 */
function splitParas(slice: string): string[] {
  return slice.split(/\r\n|\r|\n/).filter((line) => line.length > 0)
}

/** 带相对偏移的切段（渲染段落带 data-start 绝对偏移，供划线定位）。 */
function splitParasRel(slice: string): Array<{ text: string; rel: number }> {
  const out: Array<{ text: string; rel: number }> = []
  let start = 0
  for (let i = 0; i <= slice.length; i++) {
    if (i === slice.length || slice[i] === '\n') {
      const line = slice.slice(start, i).replace(/\r$/, '')
      if (line.length > 0) out.push({ text: line, rel: start })
      start = i + 1
    }
  }
  return out
}

/** DOM 版切段（供测量探针使用）。 */
function buildParagraphs(slice: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  for (const line of splitParas(slice)) {
    const div = document.createElement('div')
    div.className = 'page-para'
    div.textContent = line
    frag.appendChild(div)
  }
  return frag
}

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
      probe.replaceChildren(buildParagraphs(slice))
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
  const [highlights, setHighlights] = useState<HighlightRecord[]>([])
  const [hlQuery, setHlQuery] = useState<string | null>(null)
  const [autoPlaying, setAutoPlaying] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  /** 划线悬浮按钮：屏幕坐标 + 选区字符区间 */
  const [selBtn, setSelBtn] = useState<{
    x: number
    y: number
    start: number
    end: number
    text: string
  } | null>(null)
  /** 滚动模式（V2.1）：锚点页之后已渲染的页数、视口顶部所在页起点 */
  const [extraCount, setExtraCount] = useState(0)
  const [viewStart, setViewStart] = useState(0)

  const textRef = useRef('')
  const pagemapRef = useRef<PageMap | null>(null)
  const measurerRef = useRef<(Measurer & { refresh(): void }) | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const viewStartRef = useRef(0)
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 1600)
  }, [])

  /** 重置滚动窗口：锚点页回到窗口头部（滚动模式换页/跳转时调用）。 */
  const resetScrollWindow = useCallback(() => {
    setExtraCount(0)
    if (viewportRef.current) viewportRef.current.scrollTop = 0
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
      setViewStart(pm.current.start)
      setToc(buildToc(book.content, book.tocPattern))
      setPatternDraft(book.tocPattern ?? '')
      setBookmarks(await listBookmarks(bookId))
      setHighlights(await listHighlights(bookId))
      setReady(true)
      // 打开即记一次"最后阅读时间"
      void saveProgress(bookId, pm.current.start)
    })()
    return () => {
      cancelled = true
    }
  }, [bookId, onBack])

  // ---- 翻页 / 跳转（每次落位即写进度，写入量极小；手动操作会停止自动翻页） ----
  const turn = useCallback(
    (dir: -1 | 1) => {
      const pm = pagemapRef.current
      if (!pm) return
      setAutoPlaying(false)
      const ok = dir === 1 ? pm.goNext() : pm.goPrev()
      if (!ok) {
        showToast(dir === 1 ? '已经是最后一页了' : '已经是第一页')
        return
      }
      setPage({ ...pm.current })
      if (settings.pageMode === 'scroll') resetScrollWindow()
      void saveProgress(bookId, pm.current.start)
    },
    [bookId, showToast, settings.pageMode, resetScrollWindow],
  )

  const jumpToFraction = useCallback(
    (fraction: number) => {
      const pm = pagemapRef.current
      if (!pm || pm.totalChars === 0) return
      setAutoPlaying(false)
      const target = Math.round(fraction * (pm.totalChars - 1))
      pm.jumpTo(target)
      setPage({ ...pm.current })
      if (settings.pageMode === 'scroll') resetScrollWindow()
      void saveProgress(bookId, pm.current.start)
    },
    [bookId, settings.pageMode, resetScrollWindow],
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
    setViewStart(pm.current.start)
    // 滚动模式：重排后版面高度变化，回到锚点页头部
    if (next.pageMode === 'scroll' && viewportRef.current) viewportRef.current.scrollTop = 0
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

  /** 排版类设置统一走 commitSettings（写回 CSS 变量并锚定重排，阅读位置不丢）。 */
  const updateTypography = useCallback(
    (patch: Partial<ReaderSettings>) => {
      commitSettings({ ...settings, ...patch })
    },
    [settings, commitSettings],
  )

  /** 加载用户选择的本地字体文件（V1.3；字体数据仅本次会话有效）。 */
  const handleCustomFont = useCallback(
    async (file: File) => {
      try {
        const buffer = await file.arrayBuffer()
        const family = 'xifeng-custom-' + Date.now().toString(36)
        const face = new FontFace(family, buffer)
        await face.load()
        document.fonts.add(face)
        commitSettings({ ...settings, fontFamily: 'custom', customFontName: family })
        showToast('自定义字体已加载（本次会话有效）')
      } catch {
        showToast('字体加载失败，请换一个字体文件')
      }
    },
    [settings, commitSettings, showToast],
  )

  // ---- 划线（V3.0） ----
  const handleAddHighlight = useCallback(
    async (start: number, end: number, text: string) => {
      await addHighlight(bookId, start, end, text)
      setHighlights(await listHighlights(bookId))
      setSelBtn(null)
      window.getSelection()?.removeAllRanges()
      showToast('已添加划线')
    },
    [bookId, showToast],
  )

  const handleDeleteHighlight = useCallback(
    async (id: string) => {
      await deleteHighlight(id)
      setHighlights(await listHighlights(bookId))
      showToast('已删除划线')
    },
    [bookId, showToast],
  )

  /** 选区 → 绝对字符区间；鼠标抬起时在选区旁给出"划线"按钮。 */
  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      setSelBtn(null)
      return
    }
    const text = sel.toString()
    if (text.trim().length < 2) {
      setSelBtn(null)
      return
    }
    const range = sel.getRangeAt(0)
    const absOf = (node: Node, offset: number): number | null => {
      const el =
        node.nodeType === Node.TEXT_NODE
          ? node.parentElement
          : (node as Element)
      const para = el?.closest('[data-start]')
      if (!para) return null
      const base = Number(para.getAttribute('data-start'))
      let acc = 0
      const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT)
      let n: Node | null = walker.nextNode()
      while (n) {
        if (n === node) return base + acc + offset
        acc += n.textContent?.length ?? 0
        n = walker.nextNode()
      }
      return base + acc
    }
    const s = absOf(range.startContainer, range.startOffset)
    const e = absOf(range.endContainer, range.endOffset)
    if (s == null || e == null || e <= s) {
      setSelBtn(null)
      return
    }
    const rect = range.getBoundingClientRect()
    setSelBtn({
      x: Math.min(Math.max(rect.left + rect.width / 2, 90), window.innerWidth - 90),
      y: Math.max(rect.top - 8, 60),
      start: s,
      end: e,
      text: text.replace(/\s+/g, ' ').trim().slice(0, 120),
    })
  }, [])

  /** 点按判定：按下/抬起位移与时长都小才算点按；拖动 = 划选文字，交给浏览器。 */
  const mouseDownRef = useRef<{ x: number; y: number; t: number } | null>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    mouseDownRef.current = { x: e.clientX, y: e.clientY, t: Date.now() }
    setSelBtn(null)
  }, [])

  /** 鼠标抬起：先捕获划线选区，再按命中区域执行点按（左 30% 上一页 / 右 30% 下一页 / 中间工具栏）。 */
  const handleTapOrSelect = useCallback(
    (e: React.MouseEvent) => {
      handleMouseUp()
      const down = mouseDownRef.current
      mouseDownRef.current = null
      if (!down) return
      if (Math.abs(e.clientX - down.x) > 6 || Math.abs(e.clientY - down.y) > 6) return
      if (Date.now() - down.t > 600) return
      if (e.detail > 1) return // 双击选词不翻页
      const target = e.target as HTMLElement
      if (target.closest('button, input, a, .reader-bar, .menu-sheet, .sel-hl-btn')) return
      const rect = viewportRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = e.clientX - rect.left
      if (x < rect.width * 0.3) turn(-1)
      else if (x > rect.width * 0.7) turn(1)
      else setChromeVisible((v) => !v)
    },
    [handleMouseUp, turn],
  )


  /** 导出划线为 Markdown（V3.0）。 */
  const handleExportNotes = useCallback(() => {
    if (highlights.length === 0) {
      showToast('还没有划线')
      return
    }
    const lines = [`# 《${title}》划线笔记`, '']
    for (const h of highlights) {
      const pct = totalChars > 1 ? Math.round((h.start / (totalChars - 1)) * 100) : 0
      lines.push(`> ${h.text}（${pct}%）`)
      if (h.note) lines.push('', `  ${h.note}`)
      lines.push('')
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title || '划线'}-笔记.md`
    a.click()
    URL.revokeObjectURL(url)
    showToast('笔记已导出')
  }, [highlights, title, totalChars, showToast])

  // ---- TTS 朗读（V3.0）：按句朗读当前页，读完自动翻页继续；停止即取消 ----
  useEffect(() => {
    if (!speaking || !ready) return
    const synth = window.speechSynthesis
    if (!synth) {
      showToast('当前浏览器不支持朗读')
      setSpeaking(false)
      return
    }
    const pm = pagemapRef.current
    if (!pm) return
    const pageStr = textRef.current.slice(page.start, page.end)
    const sentences = pageStr.match(/[^。！？!?…\n]+[。！？!?…\n]*/g) ?? [pageStr]
    let idx = 0
    let cancelled = false
    const speakNext = () => {
      if (cancelled) return
      if (idx >= sentences.length) {
        if (pm.atLastPage) {
          setSpeaking(false)
          showToast('全书朗读结束')
          return
        }
        pm.goNext()
        setPage({ ...pm.current })
        void saveProgress(bookId, pm.current.start) // page.start 变化触发本 effect 朗读下一页
        return
      }
      const u = new SpeechSynthesisUtterance(sentences[idx++])
      u.lang = 'zh-CN'
      u.onend = () => speakNext()
      u.onerror = () => setSpeaking(false)
      synth.speak(u)
    }
    speakNext()
    return () => {
      cancelled = true
      synth.cancel()
    }
  }, [speaking, ready, page.start, bookId, showToast])

  /** 目录 / 书签 / 搜索统一跳转：与进度条共用 PageMap.jumpTo，同一字符偏移坐标系。 */
  const jumpToOffset = useCallback(
    (charIndex: number) => {
      const pm = pagemapRef.current
      if (!pm) return
      setAutoPlaying(false)
      pm.jumpTo(charIndex)
      setPage({ ...pm.current })
      if (settings.pageMode === 'scroll') resetScrollWindow()
      void saveProgress(bookId, pm.current.start)
      setMenuOpen(false)
    },
    [bookId, settings.pageMode, resetScrollWindow],
  )

  const openMenu = useCallback((tab: MenuTab) => {
    setMenuTab(tab)
    setMenuOpen(true)
  }, [])

  const handleAddBookmark = useCallback(async () => {
    const pm = pagemapRef.current
    if (!pm) return
    // 滚动模式以"视口顶部所在页"为当前位置
    const start = settings.pageMode === 'scroll' ? viewStartRef.current : pm.current.start
    const excerpt = textRef.current
      .slice(start, start + 48)
      .replace(/\s+/g, ' ')
      .trim()
    await addBookmark(bookId, start, excerpt)
    setBookmarks(await listBookmarks(bookId))
    showToast('已添加书签')
  }, [bookId, showToast, settings.pageMode])

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

  // ---- 阅读时长统计（V2.0）：页面可见时每 30 秒计 0.5 分钟，后台挂机不计 ----
  useEffect(() => {
    if (!ready) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void addReadingMinutes(0.5)
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [ready])

  // ---- 自动翻页（V2.0）：按设定间隔向后翻，到末页自动停止；滚动模式下滚回窗口头部 ----
  useEffect(() => {
    if (!autoPlaying || !ready) return
    const timer = window.setInterval(() => {
      const pm = pagemapRef.current
      if (!pm) return
      if (pm.atLastPage) {
        setAutoPlaying(false)
        showToast('已到最后一页，自动翻页结束')
        return
      }
      pm.goNext()
      setPage({ ...pm.current })
      if (settings.pageMode === 'scroll') resetScrollWindow()
      void saveProgress(bookId, pm.current.start)
    }, settings.autoPageSeconds * 1000)
    return () => window.clearInterval(timer)
  }, [autoPlaying, ready, settings.autoPageSeconds, settings.pageMode, bookId, showToast, resetScrollWindow])

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

  // ---- 滚动模式（V2.1）：锚点页窗口 + 触底扩展 + 顶部页进度跟踪 ----
  useEffect(() => {
    viewStartRef.current = viewStart
  }, [viewStart])

  const isScroll = settings.pageMode === 'scroll'

  /** 锚点页之后按需链式计算的页序列（fitFrom 纯函数，不改状态）。 */
  const extraPages = useMemo<Page[]>(() => {
    if (!isScroll || !ready) return []
    const pm = pagemapRef.current
    if (!pm) return []
    const pages: Page[] = []
    let from = page.end
    for (let i = 0; i < extraCount; i++) {
      if (from >= totalChars) break
      const end = pm.fitFrom(from)
      pages.push({ start: from, end })
      from = end
    }
    return pages
  }, [isScroll, ready, page.end, extraCount, totalChars])

  const lastRenderedEnd = extraPages.length ? extraPages[extraPages.length - 1].end : page.end
  const canExtend = lastRenderedEnd < totalChars

  // 视口接近底部（或未被填满）时自动追加页（末页之后停止，避免死循环）
  useEffect(() => {
    if (!isScroll || !ready || !canExtend) return
    const el = viewportRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) setExtraCount((c) => c + 2)
  }, [isScroll, ready, canExtend, extraPages, page.end])

  /** 滚动驱动：跟踪视口顶部所在页（进度/章节），触底时扩展窗口。 */
  const handleScrollFlow = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget
      let top = 0
      el.querySelectorAll<HTMLElement>('.scroll-page').forEach((d) => {
        if (d.offsetTop <= el.scrollTop + 8) top = Number(d.dataset.start)
      })
      if (top !== viewStartRef.current) {
        setViewStart(top)
        void saveProgress(bookId, top)
      }
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) setExtraCount((c) => c + 2)
    },
    [bookId],
  )

  const progressStart = isScroll ? viewStart : page.start
  const percent =
    totalChars > 1 ? (page.end >= totalChars ? 1 : progressStart / (totalChars - 1)) : 0
  const pageText = ready ? textRef.current.slice(page.start, page.end) : ''
  const chapterIdx =
    toc.entries.length > 0 ? currentChapterIndex(toc.entries, progressStart) : -1
  const chapterTitle = chapterIdx >= 0 ? toc.entries[chapterIdx].title : null

  /** 单行渲染：搜索命中（hit）与划线（hl）分段高亮，lineAbs 为行首绝对偏移。 */
  const renderLine = (line: string, lineAbs: number): ReactNode => {
    const q = hlQuery?.trim().toLowerCase()
    const ranges: Array<{ s: number; e: number; hl: boolean; hit: boolean }> = []
    if (q) {
      const lower = line.toLowerCase()
      let from = 0
      for (;;) {
        const idx = lower.indexOf(q, from)
        if (idx < 0) break
        ranges.push({ s: idx, e: idx + q.length, hl: false, hit: true })
        from = idx + 1
      }
    }
    for (const h of highlights) {
      const s = h.start - lineAbs
      const e = h.end - lineAbs
      if (e <= 0 || s >= line.length) continue
      ranges.push({ s: Math.max(0, s), e: Math.min(line.length, e), hl: true, hit: false })
    }
    if (ranges.length === 0) return line
    const cuts = new Set<number>([0, line.length])
    for (const r of ranges) {
      cuts.add(r.s)
      cuts.add(r.e)
    }
    const bounds = [...cuts].sort((a, b) => a - b)
    const parts: ReactNode[] = []
    for (let i = 0; i < bounds.length - 1; i++) {
      const s = bounds[i]
      const e = bounds[i + 1]
      if (e <= s) continue
      const hl = ranges.some((r) => r.hl && r.s <= s && e <= r.e)
      const hit = ranges.some((r) => r.hit && r.s <= s && e <= r.e)
      parts.push(
        hl || hit ? (
          <mark key={s} className={hl ? 'hl' : 'hit'}>
            {line.slice(s, e)}
          </mark>
        ) : (
          line.slice(s, e)
        ),
      )
    }
    return parts
  }

  /** 一页文本 → 段落块序列（data-start 为段落绝对偏移，供划线选区定位）。 */
  const renderSlice = (slice: string, base: number): ReactNode =>
    splitParasRel(slice).map(({ text, rel }) => (
      <div className="page-para" key={rel} data-start={base + rel}>
        {renderLine(text, base + rel)}
      </div>
    ))

  const renderContent = (): ReactNode => {
    if (!pageText) return ready && totalChars === 0 ? '（这本书没有正文内容）' : ''
    return renderSlice(pageText, page.start)
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

      <main
        ref={viewportRef}
        className={`page-viewport${isScroll ? ' scroll-mode' : ''}`}
        onMouseDown={handleMouseDown}
        onMouseUp={handleTapOrSelect}
        onScroll={isScroll ? handleScrollFlow : undefined}
      >
        {isScroll ? (
          <div className="scroll-flow">
            {totalChars === 0 ? (
              <div className="menu-empty">（这本书没有正文内容）</div>
            ) : (
              <>
                <div className="scroll-page" data-start={page.start}>
                  {renderSlice(pageText, page.start)}
                </div>
                {extraPages.map((p) => (
                  <div className="scroll-page" key={p.start} data-start={p.start}>
                    {renderSlice(textRef.current.slice(p.start, p.end), p.start)}
                  </div>
                ))}
              </>
            )}
          </div>
        ) : (
          <div className="page-content" aria-live="polite">
            {renderContent()}
          </div>
        )}
        {/* 离屏测量探针：与正文同宽同样式，仅用于分页测量 */}
        <div ref={probeRef} className="page-probe" aria-hidden="true" />
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
            <button
              className={`btn chip${autoPlaying ? ' active' : ''}`}
              title="自动向后翻页（速度在设置中调整）"
              onClick={() => setAutoPlaying((v) => !v)}
            >
              {autoPlaying ? '⏸ 停止' : '▶ 自动'}
            </button>
            <button
              className={`btn chip${speaking ? ' active' : ''}`}
              title="朗读当前页（读完自动翻页）"
              onClick={() => setSpeaking((v) => !v)}
            >
              {speaking ? '⏹ 停止朗读' : '🔊 朗读'}
            </button>
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

      {/* 划线悬浮按钮（V3.0） */}
      {selBtn && (
        <button
          className="sel-hl-btn"
          style={{ left: selBtn.x, top: selBtn.y }}
          onClick={() => void handleAddHighlight(selBtn.start, selBtn.end, selBtn.text)}
        >
          划线
        </button>
      )}

      {/* 阅读菜单（V1.2）：目录 / 书签 / 笔记 / 搜索 / 设置 */}
      <ReaderMenu
        highlights={highlights}
        onDeleteHighlight={(id) => void handleDeleteHighlight(id)}
        onExportNotes={handleExportNotes}
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
        onParaSpacing={() => updateTypography({ paraSpacing: nextParaSpacing(settings.paraSpacing) })}
        onMargin={() => updateTypography({ pageMargin: nextMargin(settings.pageMargin) })}
        onIndentToggle={() => updateTypography({ indent: !settings.indent })}
        onAlignToggle={() =>
          updateTypography({ align: settings.align === 'justify' ? 'start' : 'justify' })
        }
        onFontFamily={(name) => updateTypography({ fontFamily: name })}
        onCustomFontFile={(file) => void handleCustomFont(file)}
        onAutoSeconds={(s) => updateTypography({ autoPageSeconds: s })}
        onPageMode={(m) => updateTypography({ pageMode: m })}
      />

      {toast && <div className="toast">{toast}</div>}
    </section>
  )
}
