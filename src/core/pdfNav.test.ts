/**
 * pdfNav.ts 单元测试：页码 ↔ 字符偏移换算（V6.2 原版视图的位置互转）。
 */
import { describe, expect, it } from 'vitest'
import { PdfPageNav } from './pdfNav'

/** 3 页 PDF：每页文字起点 0 / 120 / 260，全文 400 字（末页含尾部空白）。 */
const nav = new PdfPageNav([0, 120, 260])

describe('pdfNav: 页码 → 偏移', () => {
  it('查表返回该页起始偏移', () => {
    expect(nav.offsetOfPage(0)).toBe(0)
    expect(nav.offsetOfPage(1)).toBe(120)
    expect(nav.offsetOfPage(2)).toBe(260)
  })

  it('越界钳到首/末页（不抛错）', () => {
    expect(nav.offsetOfPage(-5)).toBe(0)
    expect(nav.offsetOfPage(99)).toBe(260)
  })

  it('空表恒为 0', () => {
    const empty = new PdfPageNav([])
    expect(empty.pageCount).toBe(0)
    expect(empty.offsetOfPage(3)).toBe(0)
    expect(empty.pageOfOffset(999)).toBe(0)
  })
})

describe('pdfNav: 偏移 → 页码', () => {
  it('页首偏移属于本页', () => {
    expect(nav.pageOfOffset(0)).toBe(0)
    expect(nav.pageOfOffset(120)).toBe(1)
    expect(nav.pageOfOffset(260)).toBe(2)
  })

  it('页内偏移属于本页，含页尾前一字符', () => {
    expect(nav.pageOfOffset(1)).toBe(0)
    expect(nav.pageOfOffset(119)).toBe(0)
    expect(nav.pageOfOffset(259)).toBe(1)
    expect(nav.pageOfOffset(399)).toBe(2)
  })

  it('负值与非法值归首页', () => {
    expect(nav.pageOfOffset(-1)).toBe(0)
    expect(nav.pageOfOffset(Number.NaN)).toBe(0)
  })

  it('超出正文长度仍归末页', () => {
    expect(nav.pageOfOffset(100000)).toBe(2)
  })
})

describe('pdfNav: 页码 → 字符区间', () => {
  it('中间页区间为 [本页起点, 下页起点)', () => {
    expect(nav.rangeOfPage(1, 400)).toEqual({ start: 120, end: 260 })
  })

  it('末页区间收在正文长度（防止越界切片）', () => {
    expect(nav.rangeOfPage(2, 400)).toEqual({ start: 260, end: 400 })
  })

  it('末页起点晚于正文长度时不产生负区间', () => {
    expect(nav.rangeOfPage(2, 100)).toEqual({ start: 260, end: 260 })
  })

  it('越界页号钳到末页', () => {
    expect(nav.rangeOfPage(9, 400)).toEqual({ start: 260, end: 400 })
  })
})

describe('pdfNav: 输入容错', () => {
  it('乱序 / 负数 / 非有限值被规整为单调不减的 0 起 表', () => {
    const messy = new PdfPageNav([260, -10, 0, 120])
    expect(messy.pageCount).toBe(4)
    expect(messy.offsetOfPage(0)).toBe(0)
    expect(messy.offsetOfPage(1)).toBe(0)
    expect(messy.offsetOfPage(2)).toBe(120)
    expect(messy.offsetOfPage(3)).toBe(260)
  })

  it('NaN 起点按 0 处理（不污染二分）', () => {
    const nav2 = new PdfPageNav([Number.NaN, 50])
    expect(nav2.offsetOfPage(0)).toBe(0)
    expect(nav2.offsetOfPage(1)).toBe(50)
    expect(nav2.pageOfOffset(50)).toBe(1)
  })

  it('重复起点（空页）时偏移归更靠后的那一页', () => {
    const dup = new PdfPageNav([0, 100, 100, 200])
    expect(dup.pageOfOffset(100)).toBe(2)
    expect(dup.pageOfOffset(150)).toBe(2)
  })
})
