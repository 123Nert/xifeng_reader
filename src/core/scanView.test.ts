/**
 * scanView.ts 单元测试：扫描版位图显示几何必须恒等比（V6.1 变形回归防线）。
 *
 * 关键不变量：任何视口 / 任何 zoom 下 width/height 都等于源图宽高比 ——
 * 这正是旧实现把整页压成"横向条纹"时崩掉的那条。
 * 锚定用例覆盖"缩放时光标下的那一点不动"与其边界钳制。
 */
import { describe, expect, it } from 'vitest'
import {
  computeScanView,
  scanBoxFromViewport,
  scanFitScale,
  scrollToAnchor,
  zoomAnchor,
} from './scanView'

/** 真实样本：1224×1584 的 A4 扫描页（docs/V6.1-修复记录.md 实测表）。 */
const A4 = { srcWidth: 1224, srcHeight: 1584 }
/** 视口 705px 高、内容区宽 1228px（padding 64/26/104，正文最大宽 840 已在调用侧取小）。 */
const BOX = scanBoxFromViewport({
  clientWidth: 1280,
  clientHeight: 705,
  padLeft: 26,
  padRight: 26,
  padTop: 64,
  padBottom: 104,
})

describe('scanView: 可用内容区', () => {
  it('扣掉左右 / 上下内边距', () => {
    expect(BOX.width).toBe(1228)
    expect(BOX.height).toBe(537)
  })

  it('视口小于内边距时不为负', () => {
    const box = scanBoxFromViewport({
      clientWidth: 40,
      clientHeight: 100,
      padLeft: 26,
      padRight: 26,
      padTop: 64,
      padBottom: 104,
    })
    expect(box.width).toBe(0)
    expect(box.height).toBe(0)
  })
})

describe('scanView: 适应视口', () => {
  it('宽高同时受约束时取小者（A4 竖版受高度约束）', () => {
    expect(scanFitScale(A4.srcWidth, A4.srcHeight, BOX)).toBeCloseTo(537 / 1584, 9)
  })

  it('横向长图受宽度约束', () => {
    expect(scanFitScale(4000, 1000, BOX)).toBeCloseTo(1228 / 4000, 9)
  })

  it('小图不放大（上限 1，不拉糊）', () => {
    expect(scanFitScale(100, 100, BOX)).toBe(1)
  })

  it('可用区为 0 时返回 0（不产生 NaN / Infinity）', () => {
    expect(scanFitScale(100, 100, { width: 0, height: 0 })).toBe(0)
  })
})

describe('scanView: 显示几何恒等比', () => {
  const srcRatio = A4.srcWidth / A4.srcHeight

  it.each([1, 1.5, 2, 2.5, 3, 4])('zoom=×%s 宽高比与源图一致', (zoom) => {
    const v = computeScanView({ ...A4, box: BOX, zoom })
    expect(v.width / v.height).toBeCloseTo(srcRatio, 9)
  })

  it('zoom=×1 整页缩进内容区（高度恰好铺满，不裁剪）', () => {
    const v = computeScanView({ ...A4, box: BOX, zoom: 1 })
    expect(v.height).toBeCloseTo(BOX.height, 6)
    expect(v.width).toBeLessThanOrEqual(BOX.width)
  })

  it('zoom 每加一档尺寸精确按比例放大', () => {
    const one = computeScanView({ ...A4, box: BOX, zoom: 1 })
    const two = computeScanView({ ...A4, box: BOX, zoom: 2 })
    expect(two.width).toBeCloseTo(one.width * 2, 9)
    expect(two.height).toBeCloseTo(one.height * 2, 9)
  })

  it('×4 时宽度超出内容区（改由横向滚动查看），但比例仍与源图一致', () => {
    const v = computeScanView({ ...A4, box: BOX, zoom: 4 })
    expect(v.width).toBeGreaterThan(BOX.width)
    expect(v.width / v.height).toBeCloseTo(srcRatio, 9)
  })

  it('高而窄的视口改由宽度约束', () => {
    const tall = { width: 400, height: 2000 }
    const v = computeScanView({ ...A4, box: tall, zoom: 1 })
    expect(v.width).toBeCloseTo(400, 6)
    expect(v.width / v.height).toBeCloseTo(srcRatio, 9)
  })

  it('非法 zoom 回退适应视口', () => {
    expect(computeScanView({ ...A4, box: BOX, zoom: Number.NaN })).toEqual(
      computeScanView({ ...A4, box: BOX, zoom: 1 }),
    )
    expect(computeScanView({ ...A4, box: BOX, zoom: 0 })).toEqual(
      computeScanView({ ...A4, box: BOX, zoom: 1 }),
    )
  })

  it('零尺寸源图不产生 0 或负的显示尺寸', () => {
    const v = computeScanView({ srcWidth: 0, srcHeight: 0, box: BOX, zoom: 2 })
    expect(v.width).toBeGreaterThan(0)
    expect(v.height).toBeGreaterThan(0)
  })
})

describe('scanView: 光标锚定', () => {
  const prev = computeScanView({ ...A4, box: BOX, zoom: 2 })
  const next = computeScanView({ ...A4, box: BOX, zoom: 3 })
  /** 与真实布局一致：图片在滚动内容坐标系里居中（padding 26 + 余量半分）。 */
  const layoutFor = (w: number) => ({ left: 26 + (1228 - w) / 2, top: 64 })
  const prevLayout = layoutFor(prev.width)
  const nextLayout = layoutFor(next.width)

  it('放大后光标下的那一点仍在原处', () => {
    const scrollLeft = 300
    const scrollTop = 700
    const pointerX = 700
    const pointerY = 260
    const { rx, ry } = zoomAnchor({ ...prevLayout, ...prev, scrollLeft, scrollTop, pointerX, pointerY })
    const moved = scrollToAnchor({
      ...nextLayout,
      ...next,
      rx,
      ry,
      pointerX,
      pointerY,
      maxScrollLeft: 99999,
      maxScrollTop: 99999,
    })
    const frac = (left: number, w: number, scroll: number) => (scroll + pointerX - left) / w
    const fracY = (top: number, h: number, scroll: number) => (scroll + pointerY - top) / h
    expect(frac(nextLayout.left, next.width, moved.scrollLeft)).toBeCloseTo(
      frac(prevLayout.left, prev.width, scrollLeft),
      6,
    )
    expect(fracY(nextLayout.top, next.height, moved.scrollTop)).toBeCloseTo(
      fracY(prevLayout.top, prev.height, scrollTop),
      6,
    )
  })

  it('缩回适应态：滚动位置归零（图上已无多余可滚区域）', () => {
    const one = computeScanView({ ...A4, box: BOX, zoom: 1 })
    const oneLayout = layoutFor(one.width)
    const { rx, ry } = zoomAnchor({
      ...prevLayout,
      ...prev,
      scrollLeft: 5000,
      scrollTop: 5000,
      pointerX: 10,
      pointerY: 10,
    })
    const moved = scrollToAnchor({
      ...oneLayout,
      ...one,
      rx,
      ry,
      pointerX: 10,
      pointerY: 10,
      maxScrollLeft: 0,
      maxScrollTop: 0,
    })
    expect(moved).toEqual({ scrollLeft: 0, scrollTop: 0 })
  })

  it('锚定结果被滚动上限钳制，且不为负', () => {
    const { rx, ry } = zoomAnchor({
      left: 0,
      top: 0,
      width: prev.width,
      height: prev.height,
      scrollLeft: 0,
      scrollTop: 0,
      pointerX: 5,
      pointerY: 5,
    })
    const moved = scrollToAnchor({
      ...prevLayout,
      ...prev,
      rx,
      ry,
      pointerX: 5,
      pointerY: 5,
      maxScrollLeft: 120,
      maxScrollTop: 340,
    })
    expect(moved.scrollLeft).toBeGreaterThanOrEqual(0)
    expect(moved.scrollLeft).toBeLessThanOrEqual(120)
    expect(moved.scrollTop).toBeGreaterThanOrEqual(0)
    expect(moved.scrollTop).toBeLessThanOrEqual(340)
  })

  it('图片外的光标位置不产生越界比例（钳到 0..1）', () => {
    const { rx, ry } = zoomAnchor({
      left: 200,
      top: 100,
      width: 400,
      height: 600,
      scrollLeft: 0,
      scrollTop: 0,
      pointerX: 5,
      pointerY: 5,
    })
    expect(rx).toBe(0)
    expect(ry).toBe(0)
    expect(rx).toBeGreaterThanOrEqual(0)
    expect(ry).toBeLessThanOrEqual(1)
  })
})
