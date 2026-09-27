/**
 * pdfOriginal.ts — PDF「原版页面」渲染服务（V6.2，浏览器侧）。
 *
 * 导入 PDF 时把**原始文件整份**存进 IndexedDB（pdfFiles store），阅读时按需渲染
 * 当前页为位图 —— 版式、图片、表格、公式全都在，就是"原来的样子"。
 *
 * 为什么读时渲染、而不是导入时把所有页转成图片：
 * - 导入保持"秒开"：几百页的 PDF 不必逐页画图；
 * - 存储量 ≈ 原文件本身（几 MB），而不是每页几百 KB 的位图（几百 MB）；
 * - 放大不糊：按当前显示尺寸重新渲染，×4 也是原生清晰度（预渲染的位图做不到）；
 * - 密码/损坏判断仍由导入期的 pdf.js 完成，渲染只是二次利用同一个解析器。
 *
 * 内存策略：每次只渲染一页，渲染结果（dataURL）按 `${page}@${尺寸}` 缓存少量条目；
 * 上一个渲染任务在开始新任务前 cancel，避免连点缩放时排队画图。
 */
import {
  loadPdfjs,
  resolvePdfAssets,
  type PdfDocument,
  type PdfLoadingTask,
  type PdfjsModule,
} from './importers/pdf'

/** 渲染目标：位图要覆盖的显示尺寸（CSS px）与设备像素比。 */
export interface RenderTarget {
  /** 显示宽度（CSS px） */
  width: number
  /** 显示高度（CSS px） */
  height: number
  /** window.devicePixelRatio，用于高 DPI 屏幕；大于 2 时按 2 封顶 */
  dpr: number
}

/** 单页渲染的像素/边长上限，防超大页面（海报、图纸）撑爆内存。 */
export const MAX_RENDER_PIXELS = 12_000_000
export const MAX_RENDER_DIM = 4096
const MAX_DPR = 2

/**
 * 由页面原始尺寸（scale=1 的点数）与显示目标算渲染 scale。
 * 纯函数：宽高同比例，先按宽度取所需 scale，再按像素数/边长上限回缩。
 */
export function fitRenderScale(
  pageWidth: number,
  pageHeight: number,
  target: RenderTarget,
): number {
  const pw = Math.max(1, pageWidth)
  const ph = Math.max(1, pageHeight)
  const dpr = Math.min(MAX_DPR, Math.max(1, Number.isFinite(target.dpr) ? target.dpr : 1))
  const wantPx = Math.max(1, target.width) * dpr
  let scale = wantPx / pw

  // 像素总数上限（canvas 内存 ≈ 4 字节/像素）
  const pixels = pw * scale * (ph * scale)
  if (pixels > MAX_RENDER_PIXELS) scale *= Math.sqrt(MAX_RENDER_PIXELS / pixels)
  // 单边上限
  const longest = Math.max(pw, ph) * scale
  if (longest > MAX_RENDER_DIM) scale *= MAX_RENDER_DIM / longest

  return Math.max(0.05, scale)
}

/** 缓存键：页号 + 渲染尺寸（四舍五入到整像素，避免亚像素抖动导致永远不命中）。 */
function cacheKey(page: number, scale: number, pw: number, ph: number): string {
  return `${page}@${Math.round(pw * scale)}x${Math.round(ph * scale)}`
}

export interface RenderedPage {
  page: number
  dataUrl: string
  /** 位图实际像素尺寸 */
  width: number
  height: number
  /** 渲染用的 scale（便于判断是否已是清晰版本） */
  scale: number
}

/** 页面原始尺寸（scale=1 的点数）。 */
export interface PageSize {
  width: number
  height: number
}

/**
 * 一本书的原版渲染器：持有 pdf.js 文档与页面尺寸缓存，负责按需渲染与销毁。
 * 打开失败（文件损坏 / 环境不支持）由调用方降级到文字视图。
 */
export class PdfOriginal {
  private constructor(
    private readonly task: PdfLoadingTask,
    private readonly doc: PdfDocument,
    private readonly sizes: Map<number, PageSize>,
    private readonly cache: Map<string, RenderedPage>,
  ) {}

  private static cacheLimit = 6

  static async open(bytes: ArrayBuffer): Promise<PdfOriginal> {
    const pdfjs: PdfjsModule = await loadPdfjs()
    const assets = await resolvePdfAssets()
    const task = pdfjs.getDocument({
      // pdf.js 会 transfer 掉传入的 buffer：必须交拷贝，留给调用方的那份要完好
      data: new Uint8Array(bytes.slice(0)),
      ...assets,
      useWorkerFetch: false,
      cMapPacked: true,
      disableAutoFetch: false,
    })
    const doc = await task.promise
    return new PdfOriginal(task, doc, new Map(), new Map())
  }

  get pageCount(): number {
    return this.doc.numPages
  }

  /** 页面原始尺寸（0-based 页号）。命中缓存则不发 pdf.js 请求。 */
  async pageSize(page: number): Promise<PageSize> {
    const hit = this.sizes.get(page)
    if (hit) return hit
    const p = await this.doc.getPage(page + 1)
    const vp = p.getViewport({ scale: 1 })
    const size = { width: vp.width, height: vp.height }
    this.sizes.set(page, size)
    return size
  }

  /** 渲染取消令牌：新一轮渲染开始时置位，旧任务的结果作废。 */
  private inflight: { cancelled: boolean } | null = null

  /**
   * 渲染一页为 dataURL。target 为"位图要覆盖的显示尺寸"，函数内部换算 scale。
   * 期间若有新调用，前一个渲染被取消（返回 null），避免连点缩放时排队。
   */
  async renderPage(page: number, target: RenderTarget): Promise<RenderedPage | null> {
    const size = await this.pageSize(page)
    const scale = fitRenderScale(size.width, size.height, target)
    const key = cacheKey(page, scale, size.width, size.height)
    const cached = this.cache.get(key)
    if (cached) return cached

    // 取消上一轮（同一时刻只画一张）
    if (this.inflight) this.inflight.cancelled = true
    const token = { cancelled: false }
    this.inflight = token

    const p = await this.doc.getPage(page + 1)
    const vp = p.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.ceil(vp.width))
    canvas.height = Math.max(1, Math.ceil(vp.height))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建 canvas 2d 上下文')

    try {
      const renderTask = p.render({ canvasContext: ctx, viewport: vp } as never) as unknown as {
        promise: Promise<unknown>
        cancel?: () => void
      }
      await renderTask.promise
    } catch (e) {
      // 被新一轮取代：静默丢弃（pdf.js 取消渲染会抛 RenderingCancelledException）
      if (token.cancelled) return null
      throw e
    }
    if (token.cancelled) return null

    const out: RenderedPage = {
      page,
      dataUrl: canvas.toDataURL('image/jpeg', 0.92),
      width: canvas.width,
      height: canvas.height,
      scale,
    }
    // 简单 LRU：超限时丢最早的一条
    if (this.cache.size >= PdfOriginal.cacheLimit) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, out)
    p.cleanup?.()
    return out
  }

  async destroy(): Promise<void> {
    try {
      await this.task.destroy()
    } catch {
      /* 忽略销毁异常 */
    }
  }
}
