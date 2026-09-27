/**
 * pdf.ts — PDF 文本抽取（V6.0）。
 *
 * 设计（见 docs/V6.0-PDF支持方案.md）：
 * - pdf.js **按需加载**：本模块只在用户真的导入 PDF 时才被动态引入，
 *   其 pdf.js 依赖随之加载，常规用户（TXT/EPUB）体积零影响；
 * - 只用 pdf.js 的 getTextContent（不渲染 canvas），产出纯文本 + 字符偏移，
 *   从而批注/搜索/TTS/进度等全部能力照常复用；
 * - 丢失 PDF 原始版式与图片（换取"能舒服地读"）；扫描版明确报错并建议 OCR。
 *
 * pdf.js v6 在 Vitest 下的坑（升级 pdfjs-dist 时务必回归验证）：
 * - **Node 检测不能用 `typeof window === 'undefined'`**：Vitest 用 jsdom / happy-dom
 *   注入 window，导致 pdf.js 走 DOM 分支调 `new Worker(workerSrc, {type: "module"})`，
 *   而 Node 的 `worker_threads` 在 `postMessage(data, [transfer])` 时对含
 *   `ArrayBuffer` 的对象抛 `DataCloneError`。所以必须看 `process.versions.node`。
 * - **静态资源必须显式配置**：中文 PDF 常用「Type0 + 预定义 CMap」（如 /GBK-EUC-H），
 *   这类字体不带 ToUnicode，文字只能靠 cMapUrl 指向的 `cmaps/*.bcmap` 解出。
 *   不配置时 pdf.js 不抛错、只是每页零字符 —— 会被 looksScanned 误判成扫描版；
 *   standardFontDataUrl 则决定未嵌入的标准 14 号字体能否正确映射到 Unicode。
 * - **销毁入口在 loadingTask**：v6 的 PDFDocumentProxy 已无 `destroy()`，
 *   必须保留 loadingTask 调 `task.destroy()`，否则每导入一次就漏一个 worker。
 * - **加密判定**：通过 `error.name === 'PasswordException'` 判定（其 message 是
 *   用户输入的密码，不含 "password" 字样）；按 message 匹配会漏判。
 *   另外：在 Vitest 下 pdf.js 抛的异常可能被跨 realm 结构化克隆，
 *   `e instanceof Error` 可能为 false —— 必须按 `err.name` 字符串判定，不能 instanceof。
 * - **`data` 必须传 slice 拷贝**：pdf.js `getDocument` 会把 `data.buffer`
 *   transfer 给 worker（即使是 fake worker 也会拆 buffer）—— 第二次再用同一个
 *   ArrayBuffer 会抛 `TypeError: Cannot perform Construct on a detached ArrayBuffer`。
 *   调用方传进来的 buffer 可能只是视图（如 `Buffer.from(...)` 的池化 ArrayBuffer），
 *   直接传既不安全也让 importPdf 不能两次跑同一个 buffer 的样本。所以这里
 *   `new Uint8Array(buffer.slice(0))` 拷贝一份再交出去。
 */
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { buildToc } from '../toc'
import { ImportError, type ImportProgress, type ImportResult, type TocEntryLite } from './types'

// ---------- pdf.js 的最小类型（避免依赖其类型声明的细节） ----------

export interface PdfTextItem {
  str?: string
  hasEOL?: boolean
  width?: number
  height?: number
  /** [a,b,c,d,x,y]：x = [4]，y = [5] */
  transform?: number[]
}

interface PdfTextContent {
  items: PdfTextItem[]
}

interface PdfPage {
  getTextContent(): Promise<PdfTextContent>
  /** pdf.js 渲染管线：把当前页画到提供的 canvas 上。 */
  getViewport(opts: { scale: number }): { width: number; height: number; scale: number }
  render(opts: { canvas?: unknown; canvasContext?: unknown; viewport: unknown }): { promise: Promise<unknown> }
}

interface PdfMetadata {
  info?: { Title?: unknown; Author?: unknown }
}

interface PdfDocument {
  numPages: number
  getPage(n: number): Promise<PdfPage>
  getMetadata(): Promise<PdfMetadata>
}

/** v6：销毁入口在 loadingTask 上，不在 document 上。 */
interface PdfLoadingTask {
  promise: Promise<PdfDocument>
  destroy(): Promise<void>
}

interface PdfjsModule {
  GlobalWorkerOptions: { workerSrc: string }
  getDocument(src: unknown): PdfLoadingTask
}

/** pdf.js 的可选静态资源目录，三个 URL 都必须以 `/` 结尾（pdf.js 直接字符串拼接）。 */
export interface PdfAssetUrls {
  cMapUrl: string
  standardFontDataUrl: string
  /** V6.1：扫描版渲染必须的 jbig2/openjpeg/qcms/quickjs wasm；缺则 page.render 抛 NetworkError */
  wasmUrl: string
}

let pdfjsPromise: Promise<PdfjsModule> | null = null

/** 是否运行在 Node（含 Vitest）里：浏览器与 Node 的 pdf.js 入口、资源定位方式都不同。 */
function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && !!process.versions?.node
}

/**
 * 定位 pdf.js 静态资源目录（无需打包器插件，构建由 scripts/sync-pdfjs-assets.mjs 铺资源）：
 * - 浏览器：`pdfjs/`（相对当前文档，随 base 部署到任意子路径）；
 * - Node（单测）：从已安装的 pdfjs-dist 解析真实目录，路径原样交给 fs.readFile，
 *   Windows 反斜杠与结尾 `/` 均可（已实测）。
 */
export async function resolvePdfAssets(): Promise<PdfAssetUrls> {
  if (!isNodeRuntime()) {
    const root = new URL('pdfjs/', document.baseURI).href
    return {
      cMapUrl: `${root}cmaps/`,
      standardFontDataUrl: `${root}standard_fonts/`,
      wasmUrl: `${root}wasm/`,
    }
  }
  const { createRequire } = await import(/* @vite-ignore */ 'node:module')
  const pkgPath: string = createRequire(import.meta.url).resolve('pdfjs-dist/package.json')
  const root = pkgPath.replace(/package\.json$/, '').split('\\').join('/')
  return {
    cMapUrl: `${root}cmaps/`,
    standardFontDataUrl: `${root}standard_fonts/`,
    wasmUrl: `${root}wasm/`,
  }
}

/** 按需加载 pdf.js（浏览器带 worker，Node 测试走 legacy 主线程路径）。 */
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      if (!isNodeRuntime()) {
        const pdfjs = (await import('pdfjs-dist')) as unknown as PdfjsModule
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
        return pdfjs
      }
      // Node（单测环境）：legacy 构建可在主线程解析，无需 worker
      const mod = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule
      return mod
    })()
  }
  return pdfjsPromise
}

// ---------- 行与段落组装（纯函数，可单测） ----------

/** CJK 字符（判断是否需要插入空格）。 */
const CJK_CHAR = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * 把一页的文本片段组装为带段落结构的文本。
 * 规则见方案 §3.1：同一行按 y 判定、行内按间隙与 CJK 决定是否补空格、
 * 行间按 y 间距是否超过 1.6 倍常规行距决定是否插入空行。
 */
export function assemblePageText(items: PdfTextItem[]): string {
  if (!items || items.length === 0) return ''

  interface Part {
    str: string
    x: number
    endX: number
  }
  interface Line {
    y: number
    parts: Part[]
  }

  const lines: Line[] = []
  let cur: Line | null = null

  for (const it of items) {
    const str = it.str ?? ''
    if (!str) continue
    const t = it.transform ?? [1, 0, 0, 1, 0, 0]
    const x = t[4] ?? 0
    const y = t[5] ?? 0
    const w = it.width ?? 0
    const h = it.height ?? 12

    // 同一行判定：y 基本一致
    if (!cur || Math.abs(cur.y - y) >= 2) {
      cur = { y, parts: [] }
      lines.push(cur)
    }

    const parts = cur.parts
    if (parts.length > 0) {
      const prev = parts[parts.length - 1]
      const gap = x - prev.endX
      const prevChar = prev.str.slice(-1)
      const nextChar = str[0]
      // 有明显水平间隙且两侧都不是 CJK 时补一个空格（英文单词间距）
      if (gap > Math.max(1, h * 0.25) && !CJK_CHAR.test(prevChar) && !CJK_CHAR.test(nextChar)) {
        parts.push({ str: ' ', x: prev.endX, endX: prev.endX })
      }
    }
    parts.push({ str, x, endX: x + w })

    if (it.hasEOL) cur = null
  }

  if (lines.length === 0) return ''

  // 常规行距：相邻行 y 差的中位数
  const gaps: number[] = []
  for (let i = 1; i < lines.length; i++) {
    const g = Math.abs(lines[i - 1].y - lines[i].y)
    if (g > 0.5 && g < 200) gaps.push(g)
  }
  const lineGap = gaps.length > 0 ? median(gaps) : 0

  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].parts.map((p) => p.str).join('').trim()
    if (i > 0 && lineGap > 0) {
      const g = Math.abs(lines[i - 1].y - lines[i].y)
      // 行距明显大于常规 → 段落间隔
      if (g > lineGap * 1.6) out.push('')
    }
    if (text) out.push(text)
  }

  return out.join('\n').trim()
}

/** 由每页起始偏移构造"第 N 页"目录。 */
export function pageTocEntries(pageStarts: number[]): TocEntryLite[] {
  return pageStarts.map((charIndex, i) => ({ title: `第 ${i + 1} 页`, charIndex }))
}

/**
 * 选择目录：章节识别优先（>= 2 章），否则回退页码。
 * 抽成纯函数便于单测。
 */
export function chooseToc(text: string, pageStarts: number[]): TocEntryLite[] {
  const byChapter = buildToc(text)
  const chapters = byChapter.entries.filter((e) => e.title !== '开篇')
  if (chapters.length >= 2) return byChapter.entries
  return pageTocEntries(pageStarts)
}

/** 判定为扫描版：平均每页可提取字符过少。 */
export function looksScanned(totalChars: number, numPages: number): boolean {
  if (numPages === 0) return true
  return totalChars / numPages < 20
}

/** 取一个可能是字符串的 PDF 元信息字段。 */
function metaString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

// ---------- 主入口 ----------

export async function importPdf(
  buffer: ArrayBuffer,
  fallbackTitle: string,
  onProgress?: ImportProgress,
): Promise<ImportResult> {
  onProgress?.({ phase: '加载 PDF 解析器' })
  let pdfjs: PdfjsModule
  let assets: PdfAssetUrls
  try {
    ;[pdfjs, assets] = await Promise.all([loadPdfjs(), resolvePdfAssets()])
  } catch {
    throw new ImportError('PDF 解析器加载失败', '请检查网络后重试（首次打开 PDF 需要下载解析组件）')
  }

  onProgress?.({ phase: '解析 PDF' })
  let task: PdfLoadingTask
  let doc: PdfDocument
  try {
    task = pdfjs.getDocument({
      // pdf.js 内部对 `data` 调 `transfer(buffer)`，会 detach 我们传入的 ArrayBuffer。
      // 必须传入 *新拷贝* —— 调用方持有原 buffer，被 detach 后会出现
      // "Cannot read properties of null (reading 'resolvePdfAssets')" 等难看栈。
      data: new Uint8Array(buffer.slice(0)),
      ...assets,
      // 资源一律由主线程取（pdf.js 默认的 worker 内 fetch 需要同源且能构建 URL，
      // 部署到子路径时不稳定；主线程取保证与页面同源同基址）
      useWorkerFetch: false,
      // 位图渲染 / 扫描版会用到 wasm/ 下的 jbig2 / openjpeg / qcms，
      // 缺资源时 page.render 不抛 ImportError 而是 NetworkError，
      // 进不了我们析错逻辑 —— 所以 wasmUrl 必须传对。
      cMapPacked: true,
      disableAutoFetch: false,
    })
    doc = await task.promise
  } catch (e) {
    // 注意：pdf.js 在 Vitest 运行下抛出的异常实例做了跨 realm 结构化克隆，
    // `e instanceof Error` 为 false。必须读 `name`/`message` 字段，不能用 instanceof。
    const err = e as { name?: unknown; message?: unknown }
    const name = typeof err?.name === 'string' ? err.name : ''
    const msg = typeof err?.message === 'string' ? err.message : String(e)
    if (name === 'PasswordException' || /password/i.test(msg)) {
      throw new ImportError('这个 PDF 有密码保护', '请先解除密码保护后再导入')
    }
    // 解析失败的可见原因（如 pdf.js 的 "Invalid PDF structure"），用户排查时需要
    console.error('[pdf] getDocument failed:', name, msg)
    throw new ImportError(
      'PDF 解析失败',
      `文件可能已损坏；若来源可靠可尝试重新下载（${name || 'Error'}: ${msg.slice(0, 100)}）`,
    )
  }

  const warnings: string[] = []
  const numPages = doc.numPages
  const pageStarts: number[] = []
  const parts: string[] = []
  let cursor = 0
  let totalChars = 0

  try {
    for (let i = 1; i <= numPages; i++) {
      onProgress?.({ phase: '抽取文字', current: i, total: numPages })
      pageStarts.push(cursor)
      try {
        const page = await doc.getPage(i)
        const content = await page.getTextContent()
        const text = assemblePageText(content.items ?? [])
        if (text) {
          parts.push(text)
          cursor += text.length + 2
          totalChars += text.length
        }
      } catch (e) {
        const err = e as { name?: unknown; message?: unknown }
        const tag = typeof err?.name === 'string' ? err.name : ''
        const msg = typeof err?.message === 'string' ? err.message : String(e)
        console.error(`[pdf] page ${i} failed:`, tag, msg)
        warnings.push(`第 ${i} 页解析失败，已跳过`)
      }
    }
  } finally {
    // v6：销毁入口在 loadingTask 上（doc 上已没有 destroy），
    // 不销毁则每次导入都会留下一个 pdf.js worker 及其页面缓存
    try {
      await task.destroy()
    } catch {
      /* 忽略销毁异常 */
    }
  }

  if (looksScanned(totalChars, numPages)) {
    // —— V6.1：扫描版回退到「按页位图」通道，不再拒收 ——
    // 文字管线拿不到内容，但用户仍然想读：把每页 render 成 dataURL，
    // 由 ReaderPage 走"图像翻页"分支。Node 单测（无 DOM canvas）走不到这里，
    // 由 looksScanned 之外的逻辑报错。
    onProgress?.({ phase: '检测到扫描版，开始按页转图片', current: 0, total: numPages })
    const pageImages: Array<{ dataUrl: string; width: number; height: number }> = []

    // 浏览器专属：pdf.js 的 page.render 期望 canvasContext.canvas 是真实 HTMLCanvasElement
    // （jsdom 下 getContext('2d') 是 null）。Node 端没有 document，直接走不到这里。
    if (
      typeof globalThis.document === 'undefined' ||
      typeof globalThis.document.createElement !== 'function'
    ) {
      throw new ImportError(
        '这个 PDF 没有可提取的文字',
        '它可能是扫描版（整页是图片）。本功能需要在浏览器环境使用（npm run dev → localhost:5173）；' +
          '命令行 / 单测环境没有 canvas，无法把页面渲染成图片。请在浏览器里导入。',
      )
    }

    try {
      for (let i = 1; i <= numPages; i++) {
        onProgress?.({ phase: '渲染扫描页', current: i, total: numPages })
        let page: PdfPage | null = null
        try {
          page = await doc.getPage(i)
          const viewport = page.getViewport({ scale: 2.0 })
          // 用小尺寸即可保证阅读清晰：A4 页面宽度 ~595pt，scale 2 → 1190px，足够 1080p 屏。
          // 不让任何一页超过 MAX_DIM，避免个别超大页（图表 / 海报）撑爆内存。
          const MAX_DIM = 2000
          const scaleDown = Math.min(1, MAX_DIM / Math.max(viewport.width, viewport.height))
          const finalScale = viewport.scale * scaleDown
          const finalViewport = page.getViewport({ scale: finalScale })

          const canvas = globalThis.document.createElement('canvas')
          canvas.width = Math.ceil(finalViewport.width)
          canvas.height = Math.ceil(finalViewport.height)
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            throw new ImportError(`第 ${i} 页：无法创建 canvas 2d 上下文`)
          }

          // pdf.js v6 RenderParameters：只传 canvasContext + viewport 即可，
          // canvas 字段会自动用 canvasContext.canvas；多传反而被拒。
          await page.render({ canvasContext: ctx, viewport: finalViewport } as never).promise
          pageImages.push({
            dataUrl: canvas.toDataURL('image/jpeg', 0.85),
            width: canvas.width,
            height: canvas.height,
          })
        } catch (e) {
          // 把这一页的真实错误抛出去 —— wasm 404 / 字体解码失败 / canvas 不支持
          // 都不再被吞为"环境不支持"。Node 在 fallback 即使失败也会逐级上报 console。
          const err = e as { name?: unknown; message?: unknown; stack?: unknown }
          const name = typeof err?.name === 'string' ? err.name : ''
          const msg = typeof err?.message === 'string' ? err.message : String(e)
          console.error(`[pdf] 扫描页 ${i} 渲染失败:`, name, msg, '|', err?.stack ? String(err.stack).slice(0, 400) : '')
          throw new ImportError(
            `扫描版第 ${i} 页渲染失败`,
            `原因：${name || 'Error'} — ${msg.slice(0, 120)}。可重试一次；若仍失败请告知作者。`,
          )
        }
      }
    } finally {
      // 与文本通道一致：每本书用完即销毁，避免 pdf.js worker 长留。
      try {
        await task.destroy()
      } catch {
        /* 忽略销毁异常 */
      }
    }

    if (pageImages.length === 0) {
      // 兜底；按上面的 throw 路径，正常不会到这里
      throw new ImportError(
        '这个 PDF 没有可提取的文字',
        '它可能是扫描版（整页是图片）。请先用 OCR 工具转成文字或 EPUB 后再导入',
      )
    }

    const meta = await doc.getMetadata().catch(() => ({}))
    const info = meta && 'info' in meta && meta.info && typeof meta.info === 'object' ? meta.info as { Title?: unknown; Author?: unknown } : {}
    const title = metaString(info.Title) || fallbackTitle
    const author = metaString(info.Author) || undefined
    return {
      title,
      text: '',
      format: 'pdf',
      tocEntries: pageTocEntries(pageImages.map((_, i) => i)),
      author,
      warnings: [
        '该 PDF 是扫描版（文字层为空），已切换为图片阅读模式；搜索 / 划线 / 朗读不可用',
      ],
      scannedPages: pageImages,
    }
  }

  const text = parts.join('\n\n')
  if (!text.trim()) {
    throw new ImportError('这个 PDF 没有可提取的文字')
  }

  // 元信息
  let title = fallbackTitle
  let author: string | undefined
  try {
    const meta = await doc.getMetadata()
    const t = metaString(meta.info?.Title)
    const a = metaString(meta.info?.Author)
    if (t) title = t
    if (a) author = a
  } catch {
    /* 元信息缺失不影响导入 */
  }

  if (warnings.length > 0) {
    warnings.push(`共 ${numPages} 页，${warnings.length} 页未能解析`)
  }

  return {
    title,
    text,
    format: 'pdf',
    tocEntries: chooseToc(text, pageStarts),
    author,
    warnings,
  }
}
