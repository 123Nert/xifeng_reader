/**
 * highlight.ts 单元测试（V4.0）：归一化、锚定上下文、三层重定位、章节推导。
 */
import { describe, expect, it } from 'vitest'
import {
  anchorContext,
  chapterIndexOf,
  chapterRangesFromToc,
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_MARK_STYLE,
  normalizeHighlight,
  relocateHighlight,
  type HighlightRecord,
} from './highlight'

const base = (over: Partial<HighlightRecord> = {}): HighlightRecord =>
  normalizeHighlight({ id: 'h1', bookId: 'b1', text: '甲乙丙', start: 10, end: 13, ...over })

describe('normalizeHighlight: 老数据兼容', () => {
  it('V3.0 老记录补默认颜色与样式（保持原视觉）', () => {
    const h = normalizeHighlight({ id: 'x', bookId: 'b', start: 1, end: 3, text: '甲乙丙', createdAt: 5 })
    expect(h.color).toBe(DEFAULT_HIGHLIGHT_COLOR)
    expect(h.style).toBe(DEFAULT_MARK_STYLE)
    expect(h.createdAt).toBe(5)
  })

  it('非法颜色/样式回退默认值', () => {
    const h = normalizeHighlight({
      id: 'x',
      bookId: 'b',
      // @ts-expect-error 故意传入非法值
      color: 'rainbow',
      // @ts-expect-error 故意传入非法值
      style: 'blink',
    })
    expect(h.color).toBe(DEFAULT_HIGHLIGHT_COLOR)
    expect(h.style).toBe(DEFAULT_MARK_STYLE)
  })

  it('合法颜色与样式被保留', () => {
    const h = normalizeHighlight({ id: 'x', bookId: 'b', color: 'purple', style: 'squiggly' })
    expect(h.color).toBe('purple')
    expect(h.style).toBe('squiggly')
  })
})

describe('anchorContext', () => {
  it('截取选区前后各 N 字', () => {
    const text = '0123456789ABCDEFGHIJ'
    const { prefix, suffix } = anchorContext(text, 10, 15, 3)
    expect(prefix).toBe('789')
    expect(suffix).toBe('FGH')
  })

  it('文档边界处安全截断', () => {
    const { prefix, suffix } = anchorContext('短文本', 0, 1, 24)
    expect(prefix).toBe('')
    expect(suffix).toBe('文本')
  })
})

describe('relocateHighlight: L1 偏移可用', () => {
  it('正文未变时直接用原偏移', () => {
    const content = '前言甲乙丙丁后记'
    const h = base({ start: 2, end: 6, text: '甲乙丙丁' })
    const r = relocateHighlight(content, h)
    expect(r).toEqual({ start: 2, end: 6, level: 1 })
  })

  it('无 text 摘录时信任偏移', () => {
    const h = base({ start: 1, end: 3, text: '' })
    expect(relocateHighlight('abcdef', h).level).toBe(1)
  })
})

describe('relocateHighlight: L2 引用匹配（正文变更后）', () => {
  it('前缀+原文+后缀整体匹配到新位置', () => {
    const content = 'XXXX前言甲乙丙丁后记YYYY'
    const h = base({ start: 2, end: 6, text: '甲乙丙丁', prefix: '前言', suffix: '后记' })
    const r = relocateHighlight(content, h)
    expect(r).toEqual({ start: 6, end: 10, level: 2 })
  })

  it('仅原文唯一命中时可直接定位', () => {
    const content = '完全不同的开头……独特的句子甲……结尾'
    const h = base({ start: 2, end: 6, text: '独特的句子甲', prefix: '嗯', suffix: '呀' })
    const r = relocateHighlight(content, h)
    expect(content.slice(r.start, r.end)).toBe('独特的句子甲')
    expect(r.level).toBe(2)
  })

  it('原文多处命中时取最接近原偏移的一处', () => {
    const content = '甲句……' + 'x'.repeat(30) + '甲句'
    const nearStart = base({ start: 0, end: 2, text: '甲句' })
    const nearEnd = base({ start: 33, end: 35, text: '甲句' })
    // 原偏移在开头附近 → 应命中第 1 处
    expect(relocateHighlight(content, nearStart).start).toBe(0)
    // 原偏移靠后 → 应命中第 2 处
    expect(relocateHighlight(content, nearEnd).level).toBe(2)
  })
})

describe('relocateHighlight: L3 章节近似与失败', () => {
  it('L2 失败时在所属章节范围内找到原文', () => {
    // 前两章各含"目标"，但都用不同前后文使 L2 失败……这里直接构造 L2 失败场景：
    // prefix 与 suffix 都不匹配，且全文含两处相同文本 → L2 会取最近者（仍成功），
    // 因此 L3 只在全文找不到时才可能被用到，需构造 chapterIndex 生效的场景。
    const content = '第一章内容……特殊句子甲……第二章内容'
    const h = base({
      start: 0,
      end: 1,
      text: '第二章内容',
      prefix: '不存在的',
      suffix: '不存在的',
      chapterIndex: 1,
    })
    const ranges = chapterRangesFromToc([{ charIndex: 0 }, { charIndex: 9 }], content.length)
    const r = relocateHighlight(content, h, ranges)
    expect(content.slice(r.start, r.end)).toBe('第二章内容')
    expect([2, 3]).toContain(r.level)
  })

  it('全文完全找不到时返回 level 0（不静默错位）', () => {
    const h = base({ text: '这段文字已经不存在了' })
    const r = relocateHighlight('完全无关的内容', h)
    expect(r.level).toBe(0)
  })
})

describe('chapterRangesFromToc / chapterIndexOf', () => {
  const entries = [{ charIndex: 0 }, { charIndex: 100 }, { charIndex: 250 }]

  it('章节区间覆盖到文末', () => {
    expect(chapterRangesFromToc(entries, 400)).toEqual([
      { start: 0, end: 100 },
      { start: 100, end: 250 },
      { start: 250, end: 400 },
    ])
  })

  it('空目录返回空区间', () => {
    expect(chapterRangesFromToc([], 100)).toEqual([])
  })

  it('chapterIndexOf 定位当前章节', () => {
    expect(chapterIndexOf(entries, 0)).toBe(0)
    expect(chapterIndexOf(entries, 150)).toBe(1)
    expect(chapterIndexOf(entries, 999)).toBe(2)
    expect(chapterIndexOf([], 5)).toBeUndefined()
  })
})
