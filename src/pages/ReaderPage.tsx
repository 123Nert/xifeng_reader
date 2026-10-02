/**
 * ReaderPage.tsx — 阅读页（技术方案 §2/§3.3/§3.4）。
 * 只渲染当前页切片；翻页 / 跳转 / 锚定重排全部委托 core 层 PageMap。
 * 顶栏与底栏为悬浮层：显隐不改变正文区尺寸，避免无谓重排。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { PageMap, type Measurer, type Page } from '../core/pagination'
import {
  computeScanView,
  scanBoxFromViewport,
  scrollToAnchor,
  zoomAnchor,
} from '../core/scanView'
import { PdfPageNav } from '../core/pdfNav'
import { PdfOriginal } from '../core/pdfOriginal'
import { buildToc, currentChapterIndex, type Toc } from '../core/toc'
import {
  anchorContext,
  chapterIndexOf,
  chapterRangesFromToc,
  HIGHLIGHT_COLOR_LABELS,
  MARK_STYLE_LABELS,
  relocateHighlight,
  type HighlightColor,
  type HighlightRecord,
  type MarkStyle,
} from '../core/highlight'
import { searchText } from '../core/search'
import {
  addBookmark,
  addHighlight,
  addReadingMinutes,
  deleteBookmark,
  deleteHighlight,
  getBook,
  getPdfFile,
  getProgress,
  listBookmarks,
  listHighlights,
  listPdfPages,
  relocateHighlights,
  updateHighlight,
  saveProgress,
  updateBookTocPattern,
  addVocabRecord,
  getVocabRecord,
  listVocabByBook,
  deleteVocabRecord,
  type BookmarkRecord,
  type PdfPageRecord,
  type VocabRecord,
} from '../core/bookRepository'
import {
  buildVocabRecord,
  isVocabCandidate,
  mergeVocabOnRecollection,
  normalizeWord,
  vocabToCsv,
  vocabToMarkdown,
} from '../core/vocabulary'
import {
  applySettingsToDocument,
  clampFontSize,
  clampScanZoom,
  loadSettings,
  nextLineHeight,
  nextMargin,
  nextParaSpacing,
  saveSettings,
  SCAN_ZOOM_STEP,
  FONT_STEP,
  type ReaderSettings,
  type ThemeName,
} from '../core/settings'
import ReaderMenu, { type MenuTab } from './ReaderMenu'
import { EditCard, SelToolbar, type SelInfo } from './Annotator'
import { TranslateCard, type TranslateState } from './Translator'
import { isWordLookup, looksChinese, TranslateError, translateText } from '../core/translate'
import {
  HOVER_POLL_MS,
  isSignificantMove,
  shouldAutoDismissHover,
  type Point,
} from '../core/dismiss'

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

export default function ReaderPage({ bookId, onBack, initialOffset }: { bookId: string; onBack: () => void; initialOffset?: number }) {
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState<string | null>(null)
  const [totalChars, setTotalChars] = useState(0)
  const [page, setPage] = useState({ start: 0, end: 0 })
  // 翻页回调里读的"当前页"镜像：state 更新是异步的，useCallback 闭包可能拿到过期 page
  const pageRef = useRef(page)
  useEffect(() => {
    pageRef.current = page
  }, [page])
  const [chromeVisible, setChromeVisible] = useState(true)
  const [settings, setSettings] = useState<ReaderSettings>(() => loadSettings())
  // wheel/键盘回调里读的设置镜像：useCallback/事件闭包可能拿到过期 settings
  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])
  const [ready, setReady] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [toc, setToc] = useState<Toc>({ entries: [], source: 'none' })
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuTab, setMenuTab] = useState<MenuTab>('toc')
  const [patternDraft, setPatternDraft] = useState('')
  const [bookmarks, setBookmarks] = useState<BookmarkRecord[]>([])
  const [highlights, setHighlights] = useState<HighlightRecord[]>([])
  /** V6.6：当前书收藏的生词列表 */
  const [vocabList, setVocabList] = useState<VocabRecord[]>([])
  const [hlQuery, setHlQuery] = useState<string | null>(null)
  const [autoPlaying, setAutoPlaying] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  /** 选中态工具栏信息（V4.0） */
  const [selInfo, setSelInfo] = useState<SelInfo | null>(null)
  /** V6.4：划词翻译浮卡状态（null = 未打开） */
  const [translate, setTranslate] = useState<TranslateState | null>(null)
  /** 翻译请求的取消令牌：关闭浮卡/再选新词时丢弃在途请求 */
  const translateAbortRef = useRef<AbortController | null>(null)
  /**
   * 最近一次"送去翻译"的选区：浮卡一打开 selInfo 就被清空（工具栏要收起来），
   * 所以必须在这里单独留一份 —— 否则「存为想法」拿不到字符区间，只能干瞪眼。
   */
  const translateSelRef = useRef<SelInfo | null>(null)
  /** V6.5：浮卡出现时刻与指针轨迹，用于"鼠标移到别处就自动收起" */
  const translateShownAtRef = useRef(0)
  const pointerRef = useRef<{ pos: Point; lastMoveAt: number | null }>({
    pos: { x: -1, y: -1 },
    lastMoveAt: null,
  })
  /** 浮卡 DOM：判断指针是否停在卡内（含按钮） */
  const translateCardRef = useRef<HTMLDivElement>(null)
  /** 点开的批注编辑卡：命中的批注（可能多条重叠）+ 当前查看索引 */
  const [editState, setEditState] = useState<{ ids: string[]; index: number } | null>(null)
  /** 跳转定位后闪烁高亮的批注 id */
  const [flashId, setFlashId] = useState<string | null>(null)
  const appliedInitialOffsetRef = useRef<string | null>(null)
  /** 滚动模式（V2.1）：锚点页之后已渲染的页数、视口顶部所在页起点 */
  const [extraCount, setExtraCount] = useState(0)
  const [viewStart, setViewStart] = useState(0)
  /** V6.1/V6.2 原版页面：可用内容区（视口 − 容器内边距），位图显示尺寸的等比基准 */
  const [scanBox, setScanBox] = useState<{ width: number; height: number } | null>(null)

  const textRef = useRef('')
  /** V6.8：本书的朗读语言（EPUB 用元信息，其余按正文抽样判断），TTS 每句 utterance 都读它 */
  const bookLangRef = useRef('zh-CN')
  const pagemapRef = useRef<PageMap | null>(null)
  const measurerRef = useRef<(Measurer & { refresh(): void }) | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const viewStartRef = useRef(0)
  /** V6.2 PDF 原版视图：pdf.js 文档句柄（按需渲染当前页）+ 页码 ↔ 字符偏移换算表 */
  const pdfRef = useRef<PdfOriginal | null>(null)
  const pdfNavRef = useRef<PdfPageNav | null>(null)
  /** 原版视图当前页（0-based），翻页/跳转/进度都看它 */
  const [pdfPage, setPdfPage] = useState(0)
  const pdfPageRef = useRef(0)
  /** 原版总页数（0 = 这本书没有原版位图） */
  const [pdfPageCount, setPdfPageCount] = useState(0)
  /** 当前页的渲染结果（null = 还没画完） */
  const [pdfImage, setPdfImage] = useState<{ page: number; dataUrl: string; width: number; height: number } | null>(null)
  /** 原版视图开关：有文字层的 PDF 默认可切回文字阅读（纯图 PDF 只能看原版） */
  const [originalMode, setOriginalMode] = useState(true)
  /** V6.1 兼容：老库里按页存好的位图（新导入的 PDF 走 pdfFiles 原件通道，不再用它） */
  const scannedPagesRef = useRef<PdfPageRecord[]>([])
  /** 原版/扫描版：位图容器与位图本身（缩放时量真实几何、按光标锚定滚动） */
  const scanPaneRef = useRef<HTMLDivElement>(null)
  const scanImgRef = useRef<HTMLImageElement>(null)
  /** 位图缩放倍数镜像：wheel 连续触发时 state 尚未更新，读 ref 才不丢档 */
  const scanZoomRef = useRef(1)
  /** 待恢复的光标锚点（缩放后由 layout effect 消费一次） */
  const pendingAnchorRef = useRef<{
    rx: number
    ry: number
    pointerX: number
    pointerY: number
  } | null>(null)
  /** 从原版切到文字视图时要滚到的字符偏移（滚动模式下靠它定位，不回到开头） */
  const pendingTextAnchorRef = useRef<number | null>(null)
  /**
   * V6.5：收起译文浮卡的函数镜像。
   * 翻页 / 滚动 / 菜单等入口定义在 closeTranslate 之前，直接引用会踩 TDZ，
   * 所以用 ref 转发（真实实现定义好后立刻赋值）。
   */
  const closeTranslateRef = useRef<() => void>(() => {})
  /** 点按判定：记录按下位置与时刻（V4.0 与批注点击共同依赖） */
  const mouseDownRef = useRef<{ x: number; y: number; t: number } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 1600)
  }, [])

  /**
   * 重置滚动窗口：锚点页回到窗口头部（滚动模式换页/跳转时调用）。
   * 必须同步 viewStart，否则顶栏章节名与进度条会沿用跳转前的旧位置。
   */
  const resetScrollWindow = useCallback((newStart?: number) => {
    setExtraCount(0)
    if (newStart != null) {
      setViewStart(newStart)
      viewStartRef.current = newStart
    }
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
      // V6.8：确定本书的朗读语言 —— EPUB 优先用元信息，其余按正文前 2000 字抽样判断
      const langTag = (book.language ?? '').toLowerCase()
      bookLangRef.current = langTag
        ? langTag.startsWith('zh') ? 'zh-CN' : 'en-US'
        : looksChinese(book.content.slice(0, 2000)) ? 'zh-CN' : 'en-US'
      // V6.2：PDF —— 有原件就按"原版页面"打开（版式/图片/表格都在），
      // 文字层（若有）用于搜索 / 划线 / 朗读 / 分页续读。
      if (book.format === 'pdf') {
        const pages = book.pdfPageCount ?? 0
        setPdfPageCount(pages)
        setTitle(book.title)
        setAuthor(book.author ?? null)
        setToc(
          book.tocEntries && book.tocEntries.length > 0
            ? { entries: book.tocEntries, source: 'builtin' }
            : { entries: [], source: 'none' },
        )
        setBookmarks(await listBookmarks(bookId))
        setHighlights(await listHighlights(bookId))
        setVocabList(await listVocabByBook(bookId))
        setTotalChars(book.content.length) // 文字视图的字符总数（扫描版为 0）
        // 页码 ↔ 字符偏移换算表：原版翻页 / 跳转 / 续读靠它对齐文字坐标系。
        // 只有带文字层的 PDF 才有可用的偏移表 —— 纯图 PDF 的页起点全是 0，
        // 用它做换算会永远停在第一页，所以那种情况退回"1-based 页号"表示进度。
        pdfNavRef.current =
          book.content.length > 0 ? new PdfPageNav(book.pdfPageStarts ?? []) : null

        // 老记录（V6.1）：位图已按页存在库里 —— 没有原件时仍能看图
        const bytes = await getPdfFile(bookId)
        if (cancelled) return
        if (!bytes) {
          const stored = await listPdfPages(bookId)
          if (cancelled) return
          scannedPagesRef.current = stored
          setPdfPageCount(stored.length)
          pdfPageRef.current = 0
          setPdfPage(0)
          setReady(true)
          const saved = await getProgress(bookId)
          if (saved != null && saved > 0) jumpOriginalTo(saved)
          else void saveProgress(bookId, 1)
          return
        }

        // 打开原版渲染器：失败（文件损坏 / 环境不支持）就降级到文字视图
        try {
          const original = await PdfOriginal.open(bytes)
          if (cancelled) {
            void original.destroy()
            return
          }
          pdfRef.current = original
          if (pages === 0) setPdfPageCount(original.pageCount)
          setReady(true)
          const saved = await getProgress(bookId)
          if (saved != null && saved > 0) jumpOriginalTo(saved)
          else void saveProgress(bookId, 1)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.error('[reader] 原版渲染器打开失败，降级文字视图:', msg)
          if (cancelled) return
          setOriginalMode(false)
          showToast('原版页面打开失败，已切到文字视图')
        }
      }

      // 没有文字层的书（扫描版 PDF）：不建 PageMap，也不写进度（上面已写过页号）
      if (!book.content.trim()) {
        setReady(true)
        return
      }

      const measurer = createDomMeasurer(book.content, viewport, probe)
      const pm = new PageMap(book.content, measurer)
      const saved = await getProgress(bookId)
      if (cancelled) return
      if (saved != null && saved > 0) pm.jumpTo(saved)
      pagemapRef.current = pm
      measurerRef.current = measurer
      setTitle(book.title)
      setAuthor(book.author ?? null)
      setTotalChars(pm.totalChars)
      setPage({ ...pm.current })
      setViewStart(pm.current.start)
      // V5.0：优先使用导入时解析的真实目录（EPUB/MD/HTML），否则回退正则切分
      setToc(
        book.tocEntries && book.tocEntries.length > 0
          ? { entries: book.tocEntries, source: 'builtin' }
          : buildToc(book.content, book.tocPattern),
      )
      setPatternDraft(book.tocPattern ?? '')
      setBookmarks(await listBookmarks(bookId))
      setVocabList(await listVocabByBook(bookId))
      // 批注：加载后做三层锚定校验，正文变更（如重新净化导入）时自动修复位置
      const loaded = await listHighlights(bookId)
      const tocEntries = buildToc(book.content, book.tocPattern).entries
      const ranges = chapterRangesFromToc(tocEntries, pm.totalChars)
      const fixed: HighlightRecord[] = []
      for (const h of loaded) {
        const r = relocateHighlight(book.content, h, ranges)
        if (r.level === 1) {
          fixed.push(h)
        } else if (r.level === 2 || r.level === 3) {
          fixed.push({ ...h, start: r.start, end: r.end, updatedAt: Date.now() })
        } else {
          fixed.push({ ...h, text: h.text }) // level 0：保留内容，面板中提示位置待确认
        }
      }
      const moved = fixed.filter((f, i) => f.start !== loaded[i].start)
      if (moved.length > 0) void relocateHighlights(moved)
      setHighlights(fixed.sort((a, b) => a.start - b.start))
      setReady(true)
      // 打开即记一次"最后阅读时间"
      void saveProgress(bookId, pm.current.start)
    })()
    return () => {
      // 离开阅读页时释放 pdf.js worker 与页面缓存
      void pdfRef.current?.destroy()
      pdfRef.current = null
    }
  }, [bookId, onBack, showToast])

  // ---- 翻页 / 跳转（每次落位即写进度，写入量极小；手动操作会停止自动翻页） ----
  /** V6.2：有原版页可显示（新导入走原件按需渲染，老记录走已存好的页位图） */
  const isOriginal = pdfPageCount > 0
  /** 当前是否显示"原来的样子"：无文字层的 PDF 只有这一种视图 */
  const showOriginal = isOriginal && (originalMode || totalChars === 0)

  /** 原版页码（0-based）→ 进度值：有换算表用字符偏移，否则退回 1-based 页号。 */
  const progressOfOriginal = useCallback((pageIndex: number) => {
    const nav = pdfNavRef.current
    return nav && nav.pageCount > 0 ? nav.offsetOfPage(pageIndex) : pageIndex + 1
  }, [])

  /** 进度值 → 原版页码（0-based）。 */
  const pageOfProgress = useCallback(
    (progress: number) => {
      const nav = pdfNavRef.current
      if (nav && nav.pageCount > 0) return nav.pageOfOffset(progress)
      return Math.min(Math.max(0, Math.round(progress) - 1), Math.max(0, pdfPageCount - 1))
    },
    [pdfPageCount],
  )

  /** 定位到某个进度值所在的原版页（不写进度：调用方自己决定写什么）。 */
  const jumpOriginalTo = useCallback(
    (progress: number) => {
      const p = pageOfProgress(progress)
      pdfPageRef.current = p
      setPdfPage(p)
    },
    [pageOfProgress],
  )

  const turn = useCallback(
    (dir: -1 | 1) => {
      setAutoPlaying(false)
      // V6.5：翻页后旧译文对应的位置已经不在屏上了，直接收起
      closeTranslateRef.current()
      if (showOriginal) {
        // 原版视图：按 PDF 页翻，进度写回同一个字符偏移坐标系
        const cur = pdfPageRef.current
        const next = dir === 1 ? Math.min(cur + 1, pdfPageCount - 1) : Math.max(cur - 1, 0)
        if (next === cur) {
          showToast(dir === 1 ? '已经是最后一页了' : '已经是第一页')
          return
        }
        pdfPageRef.current = next
        setPdfPage(next)
        void saveProgress(bookId, progressOfOriginal(next))
        return
      }
      const pm = pagemapRef.current
      if (!pm) return
      const ok = dir === 1 ? pm.goNext() : pm.goPrev()
      if (!ok) {
        showToast(dir === 1 ? '已经是最后一页了' : '已经是第一页')
        return
      }
      setPage({ ...pm.current })
      if (settings.pageMode === 'scroll') resetScrollWindow(pm.current.start)
      void saveProgress(bookId, pm.current.start)
    },
    [
      bookId,
      showOriginal,
      pdfPageCount,
      progressOfOriginal,
      showToast,
      settings.pageMode,
      resetScrollWindow,
    ],
  )

  const jumpToFraction = useCallback(
    (fraction: number) => {
      setAutoPlaying(false)
      closeTranslateRef.current() // V6.5：位置变了，旧译文没意义
      if (showOriginal) {
        // 原版视图：进度条先映射到"字符偏移"（有换算表）或"页序"，再定位到对应页
        const nav = pdfNavRef.current
        const hasNav = !!nav && nav.pageCount > 0
        const span = hasNav ? totalChars : pdfPageCount
        if (span <= 1) return
        const progressValue = Math.round(fraction * (span - 1)) + (hasNav ? 0 : 1)
        const p = pageOfProgress(progressValue)
        pdfPageRef.current = p
        setPdfPage(p)
        void saveProgress(bookId, progressOfOriginal(p))
        return
      }
      const pm = pagemapRef.current
      if (!pm || pm.totalChars === 0) return
      const target = Math.round(fraction * (pm.totalChars - 1))
      pm.jumpTo(target)
      setPage({ ...pm.current })
      if (settings.pageMode === 'scroll') resetScrollWindow(pm.current.start)
      void saveProgress(bookId, pm.current.start)
    },
    [
      bookId,
      showOriginal,
      totalChars,
      pdfPageCount,
      pageOfProgress,
      progressOfOriginal,
      settings.pageMode,
      resetScrollWindow,
    ],
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
    // 镜像同步更新：Ctrl+滚轮/连点会在一帧内连续触发，读 ref 才不把多档合并成一步
    settingsRef.current = next
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
      // 读 ref 而非闭包：Ctrl+滚轮/连点会在一帧内连续触发，闭包里的字号会重复命中同一档
      const cur = settingsRef.current
      const next = clampFontSize(cur.fontSize + delta * FONT_STEP)
      if (next === cur.fontSize) {
        showToast(delta === 1 ? '已到最大字号' : '已到最小字号')
        return
      }
      commitSettings({ ...cur, fontSize: next })
      showToast(`字号 ${next}`)
    },
    [commitSettings, showToast],
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

  /** V6.1/V6.2：整页位图缩放（自由放大页面，与浏览器缩放无关）。
   *  尺寸交给 core/scanView 等比算出，CSS 一律不再钳制 —— 旧实现"定宽 + max-height
   *  压低高度"会把整页压扁，字迹糊成横向条纹（用户反馈的"字体变形"）。 */
  const applyScanZoom = useCallback((next: number, pointer?: { x: number; y: number }) => {
    const el = viewportRef.current
    const img = scanImgRef.current
    if (el && img) {
      // 记下光标下的点在当前图内的相对位置，缩放后由 layout effect 复原
      const elRect = el.getBoundingClientRect()
      const imgRect = img.getBoundingClientRect()
      const pointerX = pointer ? pointer.x - elRect.left : el.clientWidth / 2
      const pointerY = pointer ? pointer.y - elRect.top : el.clientHeight / 2
      pendingAnchorRef.current = {
        ...zoomAnchor({
          left: imgRect.left - elRect.left + el.scrollLeft,
          top: imgRect.top - elRect.top + el.scrollTop,
          width: imgRect.width,
          height: imgRect.height,
          scrollLeft: el.scrollLeft,
          scrollTop: el.scrollTop,
          pointerX,
          pointerY,
        }),
        pointerX,
        pointerY,
      }
    }
    scanZoomRef.current = next
    // 镜像一起更新：字号/排版设置读的是 settingsRef，落下这一步会把旧倍数写回去
    const merged = { ...settingsRef.current, scanZoom: next }
    settingsRef.current = merged
    setSettings(merged)
    saveSettings(merged)
  }, [])

  /** 加减一档缩放；连续滚轮/连点时以 ref 为准，不丢档。 */
  const changeScanZoom = useCallback(
    (delta: -1 | 1, pointer?: { x: number; y: number }) => {
      const cur = scanZoomRef.current
      const next = clampScanZoom(cur + delta * SCAN_ZOOM_STEP)
      if (next === cur) {
        showToast(delta === 1 ? '已放大到最大' : '已缩小到最小')
        return
      }
      applyScanZoom(next, pointer)
      showToast(`页面 ${next === 1 ? '适应屏幕' : '×' + next}`)
    },
    [applyScanZoom, showToast],
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

  // ---- 批注（V4.0） ----

  /**
   * V6.4：划词翻译。浮卡贴在选区上方，翻译在途时先显示"翻译中…"。
   * 只把选中的那一段发给翻译服务；失败只影响这张卡片，阅读一切照旧。
   */
  const startTranslate = useCallback(
    (sel: SelInfo) => {
      // 取消上一次在途请求，避免旧结果盖住新选区
      translateAbortRef.current?.abort()
      const controller = new AbortController()
      translateAbortRef.current = controller

      // 浮卡宽度约 360px：贴选区居中，并夹在视口内不越界
      const half = 190
      const x = Math.min(Math.max(sel.x, half), window.innerWidth - half)
      const y = Math.max(sel.y, 120)

      translateSelRef.current = sel
      translateShownAtRef.current = Date.now()
      // 指针对照基准重置：以浮卡出现的这一刻为起点，之后才谈得上"移开"
      pointerRef.current.lastMoveAt = null
      setSelInfo(null)
      const isWord = isVocabCandidate(sel.text)
      const norm = isWord ? normalizeWord(sel.text) : ''
      setTranslate({ source: sel.text, x, y, result: null, error: null, vocabSaved: false })
      if (isWord && norm) {
        void getVocabRecord(norm).then((rec) => {
          if (rec && !controller.signal.aborted) {
            setTranslate((prev) => (prev ? { ...prev, vocabSaved: true } : prev))
          }
        })
      }
      // 选中的单词/短语：带上它所在的整句，供翻译层在词义退化时补语境
      const context = sentenceAround(sel.text, sel.start, sel.end)
      void (async () => {
        try {
          const result = await translateText(sel.text, {
            target: settingsRef.current.translateTarget,
            context,
            signal: controller.signal,
          })
          if (controller.signal.aborted) return
          setTranslate((prev) => (prev ? { ...prev, result, error: null } : prev))
        } catch (e) {
          if (controller.signal.aborted) return
          const err = e instanceof TranslateError ? e : null
          setTranslate((prev) =>
            prev
              ? {
                  ...prev,
                  result: null,
                  error: err?.message ?? '翻译失败',
                  hint: err?.hint,
                }
              : prev,
          )
        }
      })()
    },
    [],
  )

  /** 取选区所在的整句（在正文里向前后找句末标点），供单词语境补正使用。 */
  const sentenceAround = (selText: string, start: number, end: number): string | undefined => {
    if (!isWordLookup(selText)) return undefined
    const text = textRef.current
    if (!text) return undefined
    const STOP = /[.!?。！？\n]/
    let from = start
    while (from > 0 && !STOP.test(text[from - 1])) from--
    let to = end
    while (to < text.length && !STOP.test(text[to])) to++
    const sentence = text.slice(from, Math.min(to + 1, from + 400))
    return sentence.trim() || undefined
  }

  const closeTranslate = useCallback(() => {
    translateAbortRef.current?.abort()
    translateAbortRef.current = null
    setTranslate(null)
  }, [])
  // 回填镜像：上面那些入口（turn / 滚动 / 菜单）都通过它来收起浮卡
  closeTranslateRef.current = closeTranslate

  /** V6.5：译文浮卡的开合也走 ref 镜像 —— 事件监听里读 state 会拿到过期值。 */
  const translateOpenRef = useRef(false)
  useEffect(() => {
    translateOpenRef.current = translate != null
  }, [translate])

  /** 指针是否停在浮卡内部（含按钮）；卡还没挂上时视为"不在卡内"。 */
  const isPointerInsideCard = useCallback((p: Point): boolean => {
    const el = translateCardRef.current
    if (!el) return false
    const r = el.getBoundingClientRect()
    return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom
  }, [])

  /**
   * V6.5：鼠标移到别处并停下 → 自动收起译文浮卡（不用再点 ✕）。
   * 两个来源一起判定：指针移动（记"最后一次显著移动的时刻"）+ 定时轮询
   * （"停下 500ms"本身是时间条件，光靠事件触发不了）。
   * 判定逻辑在 core/dismiss.ts，纯函数、可单测。
   */
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const now = Date.now()
      const pos = { x: e.clientX, y: e.clientY }
      const prev = pointerRef.current
      if (isSignificantMove(prev.pos, pos)) {
        prev.lastMoveAt = now
        prev.pos = pos
      } else {
        prev.pos = pos
      }
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    const timer = window.setInterval(() => {
      if (!translateOpenRef.current) return
      const inside = isPointerInsideCard(pointerRef.current.pos)
      const shouldClose = shouldAutoDismissHover({
        shownAt: translateShownAtRef.current,
        now: Date.now(),
        lastMoveAt: pointerRef.current.lastMoveAt,
        pointerInside: inside,
      })
      if (shouldClose) closeTranslate()
    }, HOVER_POLL_MS)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.clearInterval(timer)
    }
  }, [closeTranslate, isPointerInsideCard])

  /** 新建标注（选色/选样式立即标注；写想法则先建后聚焦输入）。 */
  const createHighlight = useCallback(
    async (
      start: number,
      end: number,
      text: string,
      color: HighlightColor,
      style: MarkStyle,
      wantNote = false,
    ) => {
      const pm = pagemapRef.current
      const { prefix, suffix } = anchorContext(textRef.current, start, end)
      const tocEntries = toc.entries
      const record = await addHighlight(bookId, start, end, text, {
        color,
        style,
        prefix,
        suffix,
        chapterIndex: tocEntries.length > 0 ? chapterIndexOf(tocEntries, start) : undefined,
      })
      setHighlights(await listHighlights(bookId))
      setSelInfo(null)
      window.getSelection()?.removeAllRanges()
      if (wantNote) {
        // 直接打开编辑卡，用户可立即写想法（textarea 自动聚焦）
        setEditState({ ids: [record.id], index: 0 })
      } else {
        showToast(`${HIGHLIGHT_COLOR_LABELS[color]}色${MARK_STYLE_LABELS[style]}已添加`)
      }
      void pm
      return record
    },
    [bookId, toc.entries, showToast],
  )

  /** 更新标注（改色 / 换样式 / 写想法）。 */
  const patchHighlight = useCallback(
    async (id: string, patch: Partial<Pick<HighlightRecord, 'color' | 'style' | 'note'>>) => {
      await updateHighlight(id, patch)
      setHighlights(await listHighlights(bookId))
    },
    [bookId],
  )

  /**
   * 把当前译文写进想法（note）：命中同选区的批注就追加，否则新建一条蓝色标注再写入。
   * 这样译文能随批注一起导出 Markdown（V4.0-d）。
   */
  const saveTranslationAsNote = useCallback(async () => {
    const cur = translate
    if (!cur?.result) return
    // 译文（含语境/另一义项）一并写入想法，导出 Markdown 时能看懂
    const parts = [cur.result.text]
    if (cur.result.alt) parts.push(`（也作：${cur.result.alt}）`)
    if (cur.result.context) parts.push(`整句：${cur.result.context}`)
    const line = parts.join('\n')
    const sel = translateSelRef.current
    const existing = sel
      ? highlights.find((h) => h.start === sel.start && h.end === sel.end)
      : undefined

    if (existing) {
      const note = existing.note ? existing.note + '\n💬 ' + line : line
      await patchHighlight(existing.id, { note })
      showToast('译文已写入想法')
    } else if (sel) {
      const created = await createHighlight(sel.start, sel.end, sel.text, 'blue', 'highlight')
      await patchHighlight(created.id, { note: line })
      showToast('已新建标注并写入译文')
    } else {
      // 选区信息不可用（例如跨页选区在切页后失效）：只复制，绝不误建标注
      void navigator.clipboard?.writeText(line)
      showToast('译文已复制（原选区已失效，未建标注）')
    }
    closeTranslate()
  }, [translate, highlights, patchHighlight, createHighlight, showToast, closeTranslate])

  /**
   * V6.6：收藏生词。
   * 记录单词、主释义、另一义项、整句语境与出处偏移；
   * 重复收藏时自动累加 lookups 并刷新为最近语境（对标 KOReader）。
   */
  const handleSaveVocab = useCallback(async () => {
    const cur = translate
    if (!cur?.result) return
    const sel = translateSelRef.current
    if (!sel) return
    const norm = normalizeWord(cur.source)
    if (!norm) return

    const sentence = sentenceAround(cur.source, sel.start, sel.end)
    const candidate = buildVocabRecord({
      source: cur.source,
      bookId,
      charIndex: sel.start,
      sentence,
      result: cur.result,
    })
    const existing = await getVocabRecord(norm)
    const finalRecord = existing ? mergeVocabOnRecollection(existing, candidate) : candidate
    await addVocabRecord(finalRecord)
    setVocabList(await listVocabByBook(bookId))
    setTranslate((prev) => (prev ? { ...prev, vocabSaved: true } : prev))
    showToast(
      existing
        ? `已更新生词「${norm}」语境（第 ${finalRecord.lookups} 次查词）`
        : `已加入生词本「${norm}」`,
    )
  }, [translate, bookId, showToast])

  const handleDeleteVocab = useCallback(
    async (word: string) => {
      await deleteVocabRecord(word)
      setVocabList(await listVocabByBook(bookId))
      if (translate && normalizeWord(translate.source) === word) {
        setTranslate((prev) => (prev ? { ...prev, vocabSaved: false } : prev))
      }
      showToast(`已将「${word}」移出生词本`)
    },
    [bookId, translate, showToast],
  )

  const handleExportVocabMd = useCallback(() => {
    if (vocabList.length === 0) {
      showToast('生词本还是空的')
      return
    }
    const md = vocabToMarkdown(vocabList, title)
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title || '生词本'}-生词.md`
    a.click()
    URL.revokeObjectURL(url)
    showToast(`已导出 ${vocabList.length} 个生词`)
  }, [vocabList, title, showToast])

  const handleExportVocabCsv = useCallback(() => {
    if (vocabList.length === 0) {
      showToast('生词本还是空的')
      return
    }
    const csv = vocabToCsv(vocabList)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title || '生词本'}-Anki.csv`
    a.click()
    URL.revokeObjectURL(url)
    showToast(`已导出 ${vocabList.length} 个生词到 CSV`)
  }, [vocabList, title, showToast])

  const removeHighlightById = useCallback(
    async (id: string) => {
      await deleteHighlight(id)
      setHighlights(await listHighlights(bookId))
      setEditState(null)
      showToast('已删除标注')
    },
    [bookId, showToast],
  )

  /** 点击正文命中批注 → 打开编辑卡（重叠时携带全部命中 id）。 */
  const handleContentClick = useCallback(
    (e: React.MouseEvent) => {
      const el = (e.target as HTMLElement).closest('mark.hl') as HTMLElement | null
      if (!el) return false
      const ids = (el.dataset.ids ?? '').split(',').filter(Boolean)
      if (ids.length === 0) return false
      setEditState({ ids, index: 0 })
      return true
    },
    [],
  )

  /** 选区 → 绝对字符区间；鼠标抬起时在选区旁给出标注工具栏。 */
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    // V6.5：在正文里按下鼠标 = 用户要去别处了（重新选字/翻页），先收起译文浮卡
    closeTranslateRef.current()
    mouseDownRef.current = { x: e.clientX, y: e.clientY, t: Date.now() }
  }, [])

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      setSelInfo(null)
      return
    }
    const text = sel.toString()
    if (text.trim().length < 1) {
      setSelInfo(null)
      return
    }
    const range = sel.getRangeAt(0)
    const absOf = (node: Node, offset: number): number | null => {
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
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
    const start = absOf(range.startContainer, range.startOffset)
    const end = absOf(range.endContainer, range.endOffset)
    if (start == null || end == null || end <= start) {
      setSelInfo(null)
      return
    }
    const rect = range.getBoundingClientRect()
    setSelInfo({
      x: Math.min(Math.max(rect.left + rect.width / 2, 150), window.innerWidth - 150),
      y: Math.max(rect.top - 10, 70),
      start,
      end,
      text: text.replace(/\s+/g, ' ').trim().slice(0, 200),
    })
  }, [])

  /**
   * 鼠标抬起总入口：先看是否点中已有批注（开编辑卡），否则捕获选区，
   * 最后按位移/时长判定为"点按"时执行 左30% 上一页 / 右30% 下一页 / 中间开关工具栏。
   */
  const handleTapOrSelect = useCallback(
    (e: React.MouseEvent) => {
      if (handleContentClick(e)) {
        setSelInfo(null)
        return
      }
      // 点在标记内部（含搜索高亮）不应触发翻页
      if ((e.target as HTMLElement).closest('mark')) return
      setEditState(null)
      handleMouseUp()

      const down = mouseDownRef.current
      mouseDownRef.current = null
      if (!down) return
      if (Math.abs(e.clientX - down.x) > 6 || Math.abs(e.clientY - down.y) > 6) return
      if (Date.now() - down.t > 600) return
      if (e.detail > 1) return
      const target = e.target as HTMLElement
      if (target.closest('button, input, textarea, a, .reader-bar, .menu-sheet, .sel-toolbar, .edit-card')) return
      const rect = viewportRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = e.clientX - rect.left
      if (x < rect.width * 0.3) turn(-1)
      else if (x > rect.width * 0.7) turn(1)
      else setChromeVisible((v) => !v)
    },
    [handleContentClick, handleMouseUp, turn],
  )

  /** 导出批注为 Markdown（V4.0-d）：按章节分组、颜色图例、含想法。 */
  const handleExportNotes = useCallback(
    (onlyWithNotes = false) => {
      const list = onlyWithNotes ? highlights.filter((h) => h.note) : highlights
      if (list.length === 0) {
        showToast(onlyWithNotes ? '还没有带想法的标注' : '还没有标注')
        return
      }
      const colorEmoji: Record<string, string> = {
        yellow: '🟡',
        green: '🟢',
        blue: '🔵',
        pink: '🌸',
        purple: '🟣',
        orange: '🟠',
      }
      const usedColors = [...new Set(list.map((h) => h.color))]
      const lines = [`# 《${title}》批注笔记`, '']
      lines.push(`> 导出时间：${new Date().toLocaleString()} · 共 ${list.length} 条${onlyWithNotes ? '（仅有想法）' : ''}`)
      lines.push(
        `> 图例：${usedColors.map((c) => `${colorEmoji[c]} ${HIGHLIGHT_COLOR_LABELS[c as HighlightColor]}`).join(' · ')}`,
      )
      lines.push('')

      // 按章节分组输出
      const groups = new Map<number, HighlightRecord[]>()
      for (const h of list) {
        const k = h.chapterIndex ?? -1
        const arr = groups.get(k) ?? []
        arr.push(h)
        groups.set(k, arr)
      }
      for (const [ci, arr] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
        const chapterName =
          ci >= 0 && toc.entries[ci] ? toc.entries[ci].title : ci >= 0 ? `第 ${ci + 1} 章` : '未归类'
        lines.push(`## ${chapterName}`, '')
        for (const h of arr) {
          const pct = totalChars > 1 ? Math.round((h.start / (totalChars - 1)) * 100) : 0
          const styleTag = h.style === 'highlight' ? '' : ` · ${MARK_STYLE_LABELS[h.style]}`
          lines.push(`**${colorEmoji[h.color]} ${HIGHLIGHT_COLOR_LABELS[h.color]}${styleTag}**（${pct}%）`)
          lines.push(`> ${h.text}`)
          if (h.note) {
            lines.push('')
            lines.push(`💭 ${h.note}`)
          }
          lines.push('', '---', '')
        }
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title || '批注'}-笔记.md`
      a.click()
      URL.revokeObjectURL(url)
      showToast(`已导出 ${list.length} 条批注`)
    },
    [highlights, title, totalChars, toc.entries, showToast],
  )

  // ---- TTS 朗读（V3.0）：按句朗读当前页，读完自动翻页继续；停止即取消 ----
  useEffect(() => {
    if (!speaking || !ready) return
    const synth = window.speechSynthesis
    if (!synth) {
      showToast('当前浏览器不支持朗读')
      setSpeaking(false)
      return
    }
    // 原版页面没有可朗读的文字层：原版视图下直接关掉，不静默什么都不做
    if (showOriginal) {
      setSpeaking(false)
      showToast('原版页面没有文字层，切到文字视图后可朗读')
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
      // V6.8：语言跟随本书（英文书用英文语音引擎），语速用全局设置档位
      u.lang = bookLangRef.current
      u.rate = settingsRef.current.ttsRate
      u.onend = () => speakNext()
      u.onerror = () => setSpeaking(false)
      synth.speak(u)
    }
    speakNext()
    return () => {
      cancelled = true
      synth.cancel()
    }
  }, [speaking, ready, showOriginal, page.start, bookId, showToast])

  /**
   * 目录 / 书签 / 搜索统一跳转：与进度条共用 PageMap.jumpTo，同一字符偏移坐标系。
   * 原版视图下同样先落到文字坐标系，再把原版翻到该偏移所在的页 ——
   * 两边共用同一个偏移量，来回切视图位置不乱。
   */
  const jumpToOffset = useCallback(
    (charIndex: number) => {
      const pm = pagemapRef.current
      closeTranslateRef.current() // V6.5：跳到别处，旧译文作废
      if (showOriginal) {
        setAutoPlaying(false)
        jumpOriginalTo(charIndex)
        void saveProgress(bookId, charIndex)
        setMenuOpen(false)
        return
      }
      if (!pm) return
      setAutoPlaying(false)
      pm.jumpTo(charIndex)
      setPage({ ...pm.current })
      // 滚动模式下必须同步 viewStart，否则顶栏章节名/进度仍是跳转前的位置
      if (settings.pageMode === 'scroll') resetScrollWindow(pm.current.start)
      void saveProgress(bookId, pm.current.start)
      setMenuOpen(false)
    },
    [
      bookId,
      showOriginal,
      jumpOriginalTo,
      settings.pageMode,
      resetScrollWindow,
    ],
  )

  useEffect(() => {
    if (!ready || initialOffset == null) return
    const targetKey = `${bookId}:${initialOffset}`
    if (appliedInitialOffsetRef.current === targetKey) return
    appliedInitialOffsetRef.current = targetKey
    jumpToOffset(initialOffset)
  }, [bookId, initialOffset, jumpToOffset, ready])

  const openMenu = useCallback((tab: MenuTab) => {
    closeTranslateRef.current() // V6.5：菜单要占屏，避免与译文卡叠层
    setMenuTab(tab)
    setMenuOpen(true)
  }, [])

  const handleAddBookmark = useCallback(async () => {
    // 原版视图：书签记"当前原版页对应的字符偏移"，与文字视图同一坐标系
    if (showOriginal) {
      const at = pdfNavRef.current
        ? pdfNavRef.current.offsetOfPage(pdfPageRef.current)
        : pdfPageRef.current + 1
      await addBookmark(bookId, at, `第 ${pdfPageRef.current + 1} 页`)
      setBookmarks(await listBookmarks(bookId))
      showToast('已添加书签')
      return
    }
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
  }, [bookId, showOriginal, showToast, settings.pageMode])

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
      // 原版视图有自己的页概念，交给 turn 统一处理（它也负责写进度）
      if (showOriginal) {
        turn(1)
        setAutoPlaying(false)
        return
      }
      const pm = pagemapRef.current
      if (!pm) return
      if (pm.atLastPage) {
        setAutoPlaying(false)
        showToast('已到最后一页，自动翻页结束')
        return
      }
      pm.goNext()
      setPage({ ...pm.current })
      if (settings.pageMode === 'scroll') resetScrollWindow(pm.current.start)
      void saveProgress(bookId, pm.current.start)
    }, settings.autoPageSeconds * 1000)
    return () => window.clearInterval(timer)
  }, [
    autoPlaying,
    ready,
    showOriginal,
    turn,
    settings.autoPageSeconds,
    settings.pageMode,
    bookId,
    showToast,
    resetScrollWindow,
  ])

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

  // ---- V6.1/V6.2：Ctrl/Cmd+滚轮 = 阅读区整体放大（替代浏览器缩放） ----
  // 原版页/扫描版：位图等比缩放，光标下的那一点停住不动；
  // 文字视图：走字号档位，重排后仍锚定当前阅读位置 —— 都不改浏览器缩放级别。
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const dir: -1 | 1 = e.deltaY < 0 ? 1 : -1
      if (showOriginal) {
        changeScanZoom(dir, { x: e.clientX, y: e.clientY })
      } else {
        changeFont(dir)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [showOriginal, changeScanZoom, changeFont, ready])

  // ---- V6.1/V6.2 位图视图：可用内容区随视口变化（位图尺寸由 JS 等比算，CSS 不再钳制） ----
  // 不用 ResizeObserver：它的回调挂在渲染步骤上，后台标签页（document.hidden）
  // 根本不派发，窗口尺寸变了位图会停在旧尺寸。window resize 事件在浏览器里
  // 一定会到（隐藏标签页也不例外），切回前台再补量一次。
  useLayoutEffect(() => {
    if (!showOriginal) return
    const el = viewportRef.current
    const pane = scanPaneRef.current
    if (!el || !pane) return
    const measure = () => {
      const cs = getComputedStyle(pane)
      const box = scanBoxFromViewport({
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
        padLeft: parseFloat(cs.paddingLeft) || 0,
        padRight: parseFloat(cs.paddingRight) || 0,
        padTop: parseFloat(cs.paddingTop) || 0,
        padBottom: parseFloat(cs.paddingBottom) || 0,
      })
      setScanBox((prev) =>
        prev && prev.width === box.width && prev.height === box.height ? prev : box,
      )
    }
    measure()
    window.addEventListener('resize', measure)
    document.addEventListener('visibilitychange', measure)
    return () => {
      window.removeEventListener('resize', measure)
      document.removeEventListener('visibilitychange', measure)
    }
  }, [showOriginal, ready, settings.pageMargin, pdfPageCount])

  // 缩放倍数镜像：wheel 连续触发时 settings 尚未落地，读 ref 才不丢档
  useEffect(() => {
    scanZoomRef.current = settings.scanZoom
  }, [settings.scanZoom])

  // 位图尺寸变化后用 layout effect 恢复光标锚点（此时 DOM 已是新几何，可量真实位置）
  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current
    pendingAnchorRef.current = null
    const el = viewportRef.current
    const img = scanImgRef.current
    if (!anchor || !el || !img) return
    const elRect = el.getBoundingClientRect()
    const imgRect = img.getBoundingClientRect()
    const next = scrollToAnchor({
      left: imgRect.left - elRect.left + el.scrollLeft,
      top: imgRect.top - elRect.top + el.scrollTop,
      width: imgRect.width,
      height: imgRect.height,
      rx: anchor.rx,
      ry: anchor.ry,
      pointerX: anchor.pointerX,
      pointerY: anchor.pointerY,
      maxScrollLeft: el.scrollWidth - el.clientWidth,
      maxScrollTop: el.scrollHeight - el.clientHeight,
    })
    el.scrollLeft = next.scrollLeft
    el.scrollTop = next.scrollTop
  }, [settings.scanZoom, scanBox])

  // 从原版切到文字视图：滚动到被换算出来的偏移所在页（滚动模式靠滚动定位）
  useLayoutEffect(() => {
    const at = pendingTextAnchorRef.current
    if (at == null) return
    pendingTextAnchorRef.current = null
    const el = viewportRef.current
    if (!el || !isScroll) return
    const target = [...el.querySelectorAll<HTMLElement>('.scroll-page')].find((d) => {
      const start = Number(d.dataset.start)
      return start <= at && at < start + d.textContent!.length
    })
    if (target) el.scrollTop = target.offsetTop
  }, [isScroll, showOriginal])

  // ---- V6.2 原版页面：按当前页 + 当前显示尺寸渲染（放大到多少倍都是原生清晰度） ----
  useEffect(() => {
    if (!showOriginal) return
    const original = pdfRef.current
    if (!original || !scanBox) return
    let cancelled = false
    void (async () => {
      try {
        // 先要页面原始尺寸（点数）算等比显示尺寸，再按该尺寸（×DPR）渲染
        const src = await original.pageSize(pdfPage)
        if (cancelled) return
        const view = computeScanView({
          srcWidth: src.width,
          srcHeight: src.height,
          box: scanBox,
          zoom: settings.scanZoom,
        })
        const rendered = await original.renderPage(pdfPage, {
          width: Math.max(1, Math.round(view.width)),
          height: Math.max(1, Math.round(view.height)),
          dpr: window.devicePixelRatio || 1,
        })
        if (cancelled || !rendered) return
        setPdfImage({
          page: rendered.page,
          dataUrl: rendered.dataUrl,
          width: rendered.width,
          height: rendered.height,
        })
      } catch (e) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[reader] 原版页面渲染失败:', msg)
        showToast('这一页渲染失败；可切到文字视图或重新导入')
      }
    })()
    return () => {
      cancelled = true
    }
    // ready 必须在依赖里：打开原版渲染器是异步的，首次渲染时 pdfRef 可能还是 null，
    // 少了它就再没有任何东西触发这一页重画（界面永远停在"正在渲染这一页…"）。
  }, [showOriginal, ready, pdfPage, scanBox, settings.scanZoom])

  // 翻到新一页时位图归位到左上角（上一页的放大滚动位置对不上另一页）
  useLayoutEffect(() => {
    if (!showOriginal) return
    const el = viewportRef.current
    if (!el) return
    el.scrollLeft = 0
    el.scrollTop = 0
  }, [showOriginal, pdfPage])

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
  // 原版视图下没有滚动分页，必须跳过 —— 否则 extraCount 会无限自增，撑爆渲染深度
  useEffect(() => {
    if (!isScroll || showOriginal || !ready || !canExtend) return
    const el = viewportRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) setExtraCount((c) => c + 2)
  }, [isScroll, showOriginal, ready, canExtend, extraPages, page.end])

  /** 滚动驱动：跟踪视口顶部所在页（进度/章节），触底时扩展窗口。 */
  const handleScrollFlow = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget
      const pages = el.querySelectorAll<HTMLElement>('.scroll-page')
      // 起点取首页偏移而不是 0：视口停在页首内边距里时，0 会把
      // "刚从原版切过来/刚跳到第 N 页"的位置误判成开头并写回进度
      let top = pages.length > 0 ? Number(pages[0].dataset.start) : 0
      pages.forEach((d) => {
        if (d.offsetTop <= el.scrollTop + 8) top = Number(d.dataset.start)
      })
      if (top !== viewStartRef.current) {
        setViewStart(top)
        void saveProgress(bookId, top)
      }
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) setExtraCount((c) => c + 2)
      // V6.5：开始滚动 = 已经在往下读，浮卡挡着没意义
      closeTranslateRef.current()
    },
    [bookId],
  )

  /** 位置待确认的批注（重定位失败，level 0）：由重定位结果标记 */
  const unresolvedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const h of highlights) {
      if (h.text && !textRef.current.slice(h.start, h.end).startsWith(h.text.slice(0, 8))) {
        ids.add(h.id)
      }
    }
    return ids
  }, [highlights, page])

  /** 跳转后的闪烁定位（V4.0-c） */
  useEffect(() => {
    if (!flashId) return
    const timer = window.setTimeout(() => setFlashId(null), 1600)
    return () => window.clearTimeout(timer)
  }, [flashId])

  /** 当前阅读位置（文字坐标系）：原版视图按页换算，文字视图用当前页起点 */
  const currentOffset =
    showOriginal && pdfNavRef.current
      ? pdfNavRef.current.offsetOfPage(pdfPage)
      : showOriginal
        ? pdfPage
        : isScroll
          ? viewStart
          : page.start

  const percent =
    showOriginal
      ? pdfPageCount > 1
        ? Math.min(1, pdfPage / (pdfPageCount - 1))
        : 0
      : totalChars > 1
        ? page.end >= totalChars
          ? 1
          : currentOffset / (totalChars - 1)
        : 0
  const pageText = ready && !showOriginal ? textRef.current.slice(page.start, page.end) : ''
  const chapterIdx =
    toc.entries.length > 0 ? currentChapterIndex(toc.entries, currentOffset) : -1
  const chapterTitle = showOriginal
    ? totalChars > 0
      ? // 有文字层：显示文字视图的章节/页码；纯图 PDF：只报页码
        chapterIdx >= 0
        ? `原版 · ${toc.entries[chapterIdx].title}`
        : `原版 · 第 ${pdfPage + 1}/${pdfPageCount} 页`
      : `第 ${pdfPage + 1}/${pdfPageCount} 页`
    : chapterIdx >= 0
      ? toc.entries[chapterIdx].title
      : null

  /**
   * 单行渲染：搜索命中（hit）+ 批注（hl，带颜色/样式）分段渲染。
   * 分段记录每段归属的全部批注 id（重叠时点击可切换编辑对象）。
   */
  const renderLine = (line: string, lineAbs: number): ReactNode => {
    const q = hlQuery?.trim().toLowerCase()
    const cuts = new Set<number>([0, line.length])
    const segs: Array<{ s: number; e: number; ids: string[] }> = []
    const hits: Array<{ s: number; e: number }> = []

    if (q) {
      const lower = line.toLowerCase()
      let from = 0
      for (;;) {
        const idx = lower.indexOf(q, from)
        if (idx < 0) break
        hits.push({ s: idx, e: idx + q.length })
        cuts.add(idx)
        cuts.add(idx + q.length)
        from = idx + 1
      }
    }
    // 与本行有交集的批注（含跨行/跨页片段）
    const lineAnchors: Array<{ id: string; color: HighlightColor; style: MarkStyle; s: number; e: number }> = []
    for (const h of highlights) {
      const rs = h.start - lineAbs
      const re = h.end - lineAbs
      if (re <= 0 || rs >= line.length) continue
      const s = Math.max(0, rs)
      const e = Math.min(line.length, re)
      lineAnchors.push({ id: h.id, color: h.color, style: h.style, s, e })
      cuts.add(s)
      cuts.add(e)
    }
    if (lineAnchors.length === 0 && hits.length === 0) return line

    const bounds = [...cuts].sort((a, b) => a - b)
    for (let i = 0; i < bounds.length - 1; i++) {
      const s = bounds[i]
      const e = bounds[i + 1]
      if (e <= s) continue
      const ids = lineAnchors.filter((a) => a.s <= s && e <= a.e).map((a) => a.id)
      segs.push({ s, e, ids })
    }

    return segs.map((seg) => {
      const text = line.slice(seg.s, seg.e)
      if (seg.ids.length > 0) {
        // 取最后一条（最新）批注的样式作为视觉呈现；data-ids 携带全部归属供点击切换
        const top = highlights.filter((h) => h.id === seg.ids[seg.ids.length - 1])[0]
        if (top) {
          return (
            <mark
              key={seg.s}
              className={`hl${flashId && seg.ids.includes(flashId) ? ' flash' : ''}`}
              data-ids={seg.ids.join(',')}
              data-color={top.color}
              data-style={top.style}
            >
              {text}
            </mark>
          )
        }
      }
      if (hits.some((h) => h.s <= seg.s && seg.e <= h.e)) {
        return (
          <mark key={seg.s} className="hit">
            {text}
          </mark>
        )
      }
      return text
    })
  }

  /** 一页文本 → 段落块序列（data-start 为段落绝对偏移，供划线选区定位）。 */
  const renderSlice = (slice: string, base: number): ReactNode =>
    splitParasRel(slice).map(({ text, rel }) => (
      <div className="page-para" key={rel} data-start={base + rel}>
        {renderLine(text, base + rel)}
      </div>
    ))

  const renderContent = (): ReactNode => {
    // V6.2：原版页面视图（PDF 的"原来的样子"）——
    // 新导入走 pdf.js 按当前显示尺寸实时渲染；老记录（V6.1 扫描版）用已存好的页位图。
    if (showOriginal) {
      const stored = scannedPagesRef.current[pdfPage]
      const bitmap = stored
        ? { dataUrl: stored.dataUrl, width: stored.width, height: stored.height }
        : pdfImage && pdfImage.page === pdfPage
          ? { dataUrl: pdfImage.dataUrl, width: pdfImage.width, height: pdfImage.height }
          : null
      if (!bitmap) return '（正在渲染这一页…）'
      // 显示尺寸整块交给 core/scanView 算：宽高同源，任何倍数下比例都等于源图。
      // CSS 侧对 .pdf-image 不再有任何 max-width / max-height —— 那是压扁位图的元凶。
      const view = scanBox
        ? computeScanView({
            srcWidth: bitmap.width,
            srcHeight: bitmap.height,
            box: scanBox,
            zoom: settings.scanZoom,
          })
        : null
      return (
        <img
          ref={scanImgRef}
          className="pdf-image"
          src={bitmap.dataUrl}
          alt={`第 ${pdfPage + 1} 页`}
          style={view ? { width: `${Math.round(view.width)}px`, height: `${Math.round(view.height)}px` } : undefined}
        />
      )
    }
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
          <span className="reader-chapter">{chapterTitle ?? author ?? ''}</span>
        </div>
        <div className="top-spacer" />
      </header>

      <main
        ref={viewportRef}
        className={`page-viewport${isScroll && !showOriginal ? ' scroll-mode' : ''}${showOriginal ? ' pdf-mode' : ''}`}
        onMouseDown={handleMouseDown}
        onMouseUp={handleTapOrSelect}
        onScroll={isScroll && !showOriginal ? handleScrollFlow : undefined}
      >
        {isScroll && !showOriginal ? (
          <div className="scroll-flow">
            {totalChars === 0 ? (
              <div className="menu-empty">（这本书没有正文内容）</div>
            ) : (
              <>
                <div className="scroll-page" data-start={page.start} key={`base-${page.start}`}>
                  {renderSlice(pageText, page.start)}
                </div>
                {extraPages.map((p) => (
                  <div className="scroll-page" key={`extra-${p.start}`} data-start={p.start}>
                    {renderSlice(textRef.current.slice(p.start, p.end), p.start)}
                  </div>
                ))}
              </>
            )}
          </div>
        ) : showOriginal ? (
          <div ref={scanPaneRef} className="page-content pdf-page" aria-live="polite" key="original">
            {renderContent()}
          </div>
        ) : (
          <div className="page-content" aria-live="polite" key="text">
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
          disabled={showOriginal ? pdfPageCount <= 1 : totalChars <= 1}
          onChange={(e) => onSliderInput(Number(e.target.value) / 1000)}
        />
        <div className="bottom-row">
          <span className="page-info">{Math.round(percent * 100)}%</span>
          <div className="menu-buttons">
            {showOriginal && (
              <>
                <button
                  className="btn chip"
                  title="缩小 PDF 页面"
                  onClick={() => changeScanZoom(-1)}
                >
                  －
                </button>
                <span className="page-info" title="PDF 页面缩放倍数">
                  {settings.scanZoom === 1 ? '适应' : '×' + settings.scanZoom}
                </span>
                <button
                  className="btn chip"
                  title="放大 PDF 页面（小字看得清）"
                  onClick={() => changeScanZoom(1)}
                >
                  ＋
                </button>
              </>
            )}
            <button
              className={`btn chip${autoPlaying ? ' active' : ''}`}
              title="自动向后翻页（速度在设置中调整）"
              onClick={() => setAutoPlaying((v) => !v)}
            >
              {autoPlaying ? '⏸ 停止' : '▶ 自动'}
            </button>
            {/* 原版 ↔ 文字双视图切换（只有带文字层的 PDF 才有得切） */}
            {isOriginal && totalChars > 0 && (
              <button
                className={`btn chip${originalMode ? ' active' : ''}`}
                title={originalMode ? '切到文字视图（可搜索 / 划线）' : '切回原版页面（PDF 原来的样子）'}
                onClick={() => {
                  const toText = originalMode
                  closeTranslateRef.current() // V6.5：换视图后旧译文对不上
                  // 两边共用字符偏移坐标系：切换时把位置带过去，不回到开头
                  const pm = pagemapRef.current
                  if (toText) {
                    const at = progressOfOriginal(pdfPageRef.current)
                    setOriginalMode(false)
                    // 文字视图：滚动模式下 viewStart 决定章节名与进度，先对齐再落页
                    setViewStart(at)
                    viewStartRef.current = at
                    pendingTextAnchorRef.current = at
                    if (pm) {
                      pm.jumpTo(at)
                      setPage({ ...pm.current })
                    }
                    void saveProgress(bookId, at)
                  } else {
                    // 切回原版：以"文字视图此刻显示到哪里"为准 —— 滚动模式看视口顶部页，
                    // 分页模式看当前页起点，再换算回 PDF 页
                    setOriginalMode(true)
                    jumpOriginalTo(isScroll ? viewStartRef.current : pm?.current.start ?? 0)
                  }
                }}
              >
                {originalMode ? '原版' : '文字'}
              </button>
            )}
            <button
              className={`btn chip${speaking ? ' active' : ''}`}
              title={
                showOriginal && totalChars === 0
                  ? '扫描版没有文字层，无法朗读'
                  : '朗读当前页（读完自动翻页）'
              }
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
            <button className="btn chip" onClick={() => openMenu('vocab')}>
              生词
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

      {/* 选中态标注工具栏（V4.0-a/b） */}
      {selInfo && !editState && !translate && (
        <SelToolbar
          sel={selInfo}
          onMark={(color, style) =>
            void createHighlight(selInfo.start, selInfo.end, selInfo.text, color, style)
          }
          onNote={(color, style) =>
            void createHighlight(selInfo.start, selInfo.end, selInfo.text, color, style, true)
          }
          onTranslate={() => void startTranslate(selInfo)}
          onClose={() => setSelInfo(null)}
        />
      )}

      {/* 划词翻译浮卡（V6.4） */}
      {translate && (
        <TranslateCard
          state={translate}
          cardRef={translateCardRef}
          onCopy={(text) => {
            void navigator.clipboard?.writeText(text)
            showToast('已复制译文')
          }}
          onSaveNote={() => void saveTranslationAsNote()}
          onSaveVocab={() => void handleSaveVocab()}
          onClose={() => setTranslate(null)}
        />
      )}

      {/* 批注编辑卡（V4.0-b/c） */}
      {editState && (
        <div className="edit-card-mask" onClick={() => setEditState(null)}>
          <EditCard
            items={
              editState.ids
                .map((id) => highlights.find((h) => h.id === id))
                .filter(Boolean) as HighlightRecord[]
            }
            index={Math.min(editState.index, editState.ids.length - 1)}
            onSwitch={(next) => setEditState({ ...editState, index: next })}
            onRecolor={(color) => void patchHighlight(editState.ids[editState.index], { color })}
            onRestyle={(style) => void patchHighlight(editState.ids[editState.index], { style })}
            onSaveNote={(note) => void patchHighlight(editState.ids[editState.index], { note })}
            onDelete={() => void removeHighlightById(editState.ids[editState.index])}
            onCopy={() => {
              const cur = highlights.find((h) => h.id === editState.ids[editState.index])
              if (cur) {
                void navigator.clipboard?.writeText(cur.text)
                showToast('已复制原文')
              }
            }}
            onClose={() => setEditState(null)}
          />
        </div>
      )}

      {/* 阅读菜单（V1.2）：目录 / 书签 / 笔记 / 搜索 / 设置 */}
      <ReaderMenu
        highlights={highlights}
        onDeleteHighlight={(id) => void removeHighlightById(id)}
        onExportNotes={() => handleExportNotes(false)}
        onJumpHighlight={(id) => {
          const h = highlights.find((x) => x.id === id)
          if (h) {
            jumpToOffset(h.start)
            setFlashId(h.id)
          }
        }}
        chapterTitles={toc.entries.map((e) => e.title)}
        unresolvedIds={unresolvedIds}
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
        vocabList={vocabList}
        onDeleteVocab={(w) => void handleDeleteVocab(w)}
        onExportVocabMd={handleExportVocabMd}
        onExportVocabCsv={handleExportVocabCsv}
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
        onTranslateTarget={(t) => {
          // 翻译语言只影响下一次划词，不涉排版 → 轻量更新（不重排、阅读位置不动）
          const next = { ...settings, translateTarget: t }
          settingsRef.current = next
          setSettings(next)
          saveSettings(next)
        }}
        onTtsRate={(r) => {
          // 朗读语速同样只影响下一次朗读 → 轻量更新
          const next = { ...settings, ttsRate: r }
          settingsRef.current = next
          setSettings(next)
          saveSettings(next)
        }}
      />

      {toast && <div className="toast">{toast}</div>}
    </section>
  )
}
