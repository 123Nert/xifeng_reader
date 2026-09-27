/**
 * pdfOriginal.ts 单元测试：原版页渲染的几何计算（纯函数部分）。
 *
 * 渲染本身依赖 DOM canvas / pdf.js worker，只在浏览器里跑；
 * 这里覆盖"渲染 scale 怎么算"这条最容易被上限逻辑写错的分支。
 */
import { describe, expect, it } from 'vitest'
import { fitRenderScale, MAX_RENDER_DIM, MAX_RENDER_PIXELS, type RenderTarget } from './pdfOriginal'

/** A4（595×842 pt）在一屏 1280×720 的适应态里显示约 415 CSS px 宽。 */
const A4 = { w: 595, h: 842 }
const target = (width: number, dpr = 1): RenderTarget => ({ width, height: width * 1.414, dpr })

describe('pdfOriginal: fitRenderScale', () => {
  it('按显示宽度与 DPR 换算 scale（覆盖到目标像素）', () => {
    // 目标 595 CSS px、DPR 1 → scale 1（正好 1:1 像素）
    expect(fitRenderScale(A4.w, A4.h, target(595, 1))).toBeCloseTo(1, 6)
    // 目标 300 CSS px、DPR 2 → 需要 600 像素宽 → scale ≈ 1.008
    expect(fitRenderScale(A4.w, A4.h, target(300, 2))).toBeCloseTo(600 / 595, 6)
  })

  it('放大到 4 倍时 scale 同步放大（字迹是原生清晰度，不是拉伸位图）', () => {
    const one = fitRenderScale(A4.w, A4.h, target(400, 1))
    const four = fitRenderScale(A4.w, A4.h, target(1600, 1))
    expect(four / one).toBeCloseTo(4, 6)
  })

  it('DPR 上限 2（3x 屏不再翻倍内存）', () => {
    expect(fitRenderScale(A4.w, A4.h, target(400, 3))).toBeCloseTo(
      fitRenderScale(A4.w, A4.h, target(400, 2)),
      6,
    )
  })

  it('像素总数超上限时回缩（超大页面不撑爆 canvas）', () => {
    const scale = fitRenderScale(2000, 3000, target(4000, 2))
    expect(2000 * scale * (3000 * scale)).toBeLessThanOrEqual(MAX_RENDER_PIXELS * 1.001)
  })

  it('单边超上限时回缩', () => {
    const scale = fitRenderScale(100, 20000, target(100, 1))
    expect(20000 * scale).toBeLessThanOrEqual(MAX_RENDER_DIM * 1.001)
  })

  it('非法输入不产生 0 / NaN / 负 scale', () => {
    expect(fitRenderScale(0, 0, target(100, 1))).toBeGreaterThan(0)
    expect(fitRenderScale(A4.w, A4.h, { width: 0, height: 0, dpr: Number.NaN })).toBeGreaterThan(0)
    expect(Number.isFinite(fitRenderScale(A4.w, A4.h, target(100, Number.NaN)))).toBe(true)
  })
})
