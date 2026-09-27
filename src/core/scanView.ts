/**
 * scanView.ts — 扫描版 PDF 位图的显示几何（纯函数，V6.1 修复：等比缩放，禁止变形）。
 *
 * 位图必须"整体等比"缩放：只要 CSS 里还留着 max-height / max-width 参与竞争，
 * 浏览器就会在"已指定宽度"的前提下单独压低高度 —— 图片被纵向压扁，字迹糊成条纹。
 * 因此显示尺寸统一由本模块算好（宽高同源、比例恒等于源图），CSS 不再对位图施加钳制。
 *
 * 缩放倍数的基准是"适应视口"（zoom = 1 → 整页缩进一屏），而不是源图像素：
 * ×2 就是屏幕上的两倍大，与源分辨率解耦。
 *
 * 数值保持精确（不取整），调用方写 CSS 时才 round —— 取整在等比链路上会引入比例漂移。
 */

export interface ScanBox {
  /** 可用内容区宽度（视口宽 − 左右内边距，且不超过正文最大宽度） */
  width: number
  /** 可用内容区高度（视口高 − 上下内边距，即悬浮工具栏预留） */
  height: number
}

export interface ScanSize {
  /** 显示宽度（px，宽高比恒等于源图） */
  width: number
  /** 显示高度（px，宽高比恒等于源图） */
  height: number
}

/** 由视口尺寸与容器内边距算可用内容区。 */
export function scanBoxFromViewport(input: {
  clientWidth: number
  clientHeight: number
  padLeft: number
  padRight: number
  padTop: number
  padBottom: number
}): ScanBox {
  return {
    width: Math.max(0, input.clientWidth - input.padLeft - input.padRight),
    height: Math.max(0, input.clientHeight - input.padTop - input.padBottom),
  }
}

/**
 * 适应视口的缩放系数：同时受宽、高约束，取小者。
 * 上限 1 —— 小图不强行放大拉糊，与原「适应」观感一致。
 */
export function scanFitScale(srcWidth: number, srcHeight: number, box: ScanBox): number {
  const w = Math.max(1, srcWidth)
  const h = Math.max(1, srcHeight)
  if (!(box.width > 0) || !(box.height > 0)) return 0
  return Math.min(1, box.width / w, box.height / h)
}

/**
 * 算出位图的显示尺寸。zoom 为相对"适应视口"的倍数（1 = 适应，>1 = 整体放大）。
 * 宽高由同一个系数得出，任何 zoom 下比例都与源图一致。
 */
export function computeScanView(opts: {
  srcWidth: number
  srcHeight: number
  box: ScanBox
  zoom: number
}): ScanSize {
  const srcWidth = Math.max(1, opts.srcWidth)
  const srcHeight = Math.max(1, opts.srcHeight)
  const zoom = Number.isFinite(opts.zoom) && opts.zoom > 0 ? opts.zoom : 1
  const scale = scanFitScale(srcWidth, srcHeight, opts.box) * zoom
  return { width: srcWidth * scale, height: srcHeight * scale }
}

/**
 * 记下"光标正下方那一点"在旧图内的相对位置（0..1）。
 * 位图位置由调用方从真实 DOM 量出（滚动容器内容坐标系），因此
 * 居中的 auto margin、正文最大宽度、容器内边距都自动被算进去。
 */
export function zoomAnchor(opts: {
  /** 图片左上角在滚动内容坐标系里的位置 */
  left: number
  top: number
  width: number
  height: number
  scrollLeft: number
  scrollTop: number
  /** 光标相对滚动容器左上角的坐标 */
  pointerX: number
  pointerY: number
}): { rx: number; ry: number } {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
  return {
    rx: clamp01((opts.scrollLeft + opts.pointerX - opts.left) / Math.max(1, opts.width)),
    ry: clamp01((opts.scrollTop + opts.pointerY - opts.top) / Math.max(1, opts.height)),
  }
}

/**
 * 按锚点在缩放后的新几何里反算滚动位置 —— 光标下的那一点停在原处，缩放不"跑偏"。
 * 结果按滚动上限钳制，不会负滚或越界。
 */
export function scrollToAnchor(opts: {
  /** 缩放后图片左上角在滚动内容坐标系里的位置 */
  left: number
  top: number
  width: number
  height: number
  /** zoomAnchor 记下的相对位置 */
  rx: number
  ry: number
  pointerX: number
  pointerY: number
  maxScrollLeft: number
  maxScrollTop: number
}): { scrollLeft: number; scrollTop: number } {
  const clamp = (v: number, max: number) => Math.min(Math.max(0, max), Math.max(0, v))
  return {
    scrollLeft: clamp(opts.left + opts.rx * opts.width - opts.pointerX, opts.maxScrollLeft),
    scrollTop: clamp(opts.top + opts.ry * opts.height - opts.pointerY, opts.maxScrollTop),
  }
}
