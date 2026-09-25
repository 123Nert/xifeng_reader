/**
 * pagination.ts 单元测试（技术方案 §5）。
 * 注入按行填充规则模拟 pre-wrap 排版的假 Measurer，覆盖：
 * 页界铺满全文、前后翻页、跳转数学、锚定重排、边界与百万字规模。
 */
import { describe, expect, it } from 'vitest'
import { PageMap, type Measurer } from './pagination'

interface FakeOpts {
  charsPerLine: number
  linesPerPage: number
}

/**
 * 假 Measurer：模拟 white-space: pre-wrap 的换行规则——
 * '\n' 强制换行，普通字符超出每行宽度自动折行，行数超出页高即放不下。
 */
function makeFakeMeasurer(text: string, opts: FakeOpts): Measurer & { opts: FakeOpts } {
  const fits = (start: number, n: number): boolean => {
    if (n <= 0) return true
    let lines = 1
    let col = 0
    const end = Math.min(start + n, text.length)
    for (let i = start; i < end; i++) {
      if (text[i] === '\n') {
        lines++
        col = 0
      } else if (++col > opts.charsPerLine) {
        lines++
        col = 1
      }
    }
    return lines <= opts.linesPerPage
  }
  return {
    opts,
    estimateCapacity: () => opts.charsPerLine * opts.linesPerPage,
    fits,
  }
}

/** 确定性伪随机长文：段落之间用 \n\n 分隔，模拟真实小说版面。 */
function makeNovelText(paragraphs: number): string {
  let seed = 42
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const chars = '山河远灯火风雪夜人归舟桥屋檐下听雨声读书处江湖辽阔岁月长'
  const paras: string[] = []
  for (let i = 0; i < paragraphs; i++) {
    let p = ''
    const sentences = 1 + Math.floor(rand() * 3)
    for (let s = 0; s < sentences; s++) {
      const len = 8 + Math.floor(rand() * 40)
      for (let c = 0; c < len; c++) p += chars[Math.floor(rand() * chars.length)]
      p += '。'
    }
    paras.push(p)
  }
  return paras.join('\n\n')
}

const NOVEL = makeNovelText(400) // 约 3~5 万字符

describe('PageMap: fitFrom 页界 maximality', () => {
  it('fitFrom 返回的页是"最大可容纳"：再加一个字符就放不下', () => {
    const m = makeFakeMeasurer(NOVEL, { charsPerLine: 10, linesPerPage: 5 })
    const pm = new PageMap(NOVEL, m)
    for (let i = 0; i < 50; i++) {
      const start = Math.floor((NOVEL.length - 1) * (i / 50))
      const end = pm.fitFrom(start)
      expect(end).toBeGreaterThan(start)
      expect(m.fits(start, end - start)).toBe(true)
      if (end < NOVEL.length) {
        expect(m.fits(start, end - start + 1)).toBe(false)
      }
    }
  })
})

describe('PageMap: 前后翻页', () => {
  it('从第一页翻到最后一页，页区间无遗漏、无重叠、单调递增', () => {
    const pm = new PageMap(NOVEL, makeFakeMeasurer(NOVEL, { charsPerLine: 20, linesPerPage: 6 }))
    let guard = 0
    while (!pm.atLastPage && guard++ < NOVEL.length) {
      const prevEnd = pm.current.end
      expect(pm.goNext()).toBe(true)
      // 新页起点必须严格等于上一页终点，且页严格前进
      expect(pm.current.start).toBe(prevEnd)
      expect(pm.current.end).toBeGreaterThan(prevEnd)
    }
    expect(pm.current.end).toBe(NOVEL.length)
    expect(pm.goNext()).toBe(false)
  })

  it('goPrev 页尾严格接上当前页起点，往返完全一致', () => {
    const m = makeFakeMeasurer(NOVEL, { charsPerLine: 20, linesPerPage: 6 })
    const pm = new PageMap(NOVEL, m)
    pm.goNext()
    pm.goNext()
    pm.goNext()
    pm.goNext()
    const forward = { ...pm.current }

    expect(pm.goPrev()).toBe(true)
    // 上一页页尾严格等于当前页起点，且内容确实放得进一页
    expect(pm.current.end).toBe(forward.start)
    expect(m.fits(pm.current.start, forward.start - pm.current.start)).toBe(true)
    expect(pm.current.start).toBeLessThan(forward.start)

    pm.goNext()
    expect(pm.current).toEqual(forward)
  })

  it('第一页 goPrev 返回 false，位置不变', () => {
    const pm = new PageMap(NOVEL, makeFakeMeasurer(NOVEL, { charsPerLine: 20, linesPerPage: 6 }))
    const first = { ...pm.current }
    expect(pm.goPrev()).toBe(false)
    expect(pm.current).toEqual(first)
  })
})

describe('PageMap: 跳转', () => {
  it.each([0, 1, 123, 4567, NOVEL.length - 1])('jumpTo(%d) 落点页包含目标字符', (t) => {
    const pm = new PageMap(NOVEL, makeFakeMeasurer(NOVEL, { charsPerLine: 20, linesPerPage: 6 }))
    pm.jumpTo(t)
    expect(pm.current.start).toBeLessThanOrEqual(t)
    expect(pm.current.end).toBeGreaterThan(t)
  })

  it('跳转后一直翻到末尾，页区间仍然无缝铺满（跳转不破坏可读性）', () => {
    const pm = new PageMap(NOVEL, makeFakeMeasurer(NOVEL, { charsPerLine: 20, linesPerPage: 6 }))
    pm.jumpTo(Math.floor(NOVEL.length * 0.6))
    expect(pm.current.end).toBeGreaterThan(pm.current.start)
    let guard = 0
    while (!pm.atLastPage && guard++ < NOVEL.length) {
      const prevEnd = pm.current.end
      pm.goNext()
      expect(pm.current.start).toBe(prevEnd)
    }
    expect(pm.current.end).toBe(NOVEL.length)
  })

  it('jumpTo 越界收敛到两端', () => {
    const pm = new PageMap(NOVEL, makeFakeMeasurer(NOVEL, { charsPerLine: 20, linesPerPage: 6 }))
    pm.jumpTo(-100)
    expect(pm.current.start).toBe(0)
    pm.jumpTo(NOVEL.length + 999)
    expect(pm.atLastPage)
    expect(pm.current.end).toBe(NOVEL.length)
  })
})

describe('PageMap: 锚定重排', () => {
  it('字号变更（容量变小）后 reflow 保持当前页起点不变，新页按新度量放下', () => {
    const m = makeFakeMeasurer(NOVEL, { charsPerLine: 20, linesPerPage: 6 })
    const pm = new PageMap(NOVEL, m)
    pm.goNext()
    pm.goNext()
    const anchor = pm.current.start

    m.opts.charsPerLine = 12 // 模拟字号变大，每行容纳字符变少
    m.opts.linesPerPage = 5
    pm.reflow()
    expect(pm.current.start).toBe(anchor)
    expect(m.fits(pm.current.start, pm.current.end - pm.current.start)).toBe(true)
  })

  it('容量变大后 reflow 同样保持锚点且不越界', () => {
    const m = makeFakeMeasurer(NOVEL, { charsPerLine: 10, linesPerPage: 4 })
    const pm = new PageMap(NOVEL, m)
    pm.goNext()
    const anchor = pm.current.start

    m.opts.charsPerLine = 30
    m.opts.linesPerPage = 8
    pm.reflow()
    expect(pm.current.start).toBe(anchor)
    expect(m.fits(pm.current.start, pm.current.end - pm.current.start)).toBe(true)
  })
})

describe('PageMap: prevStart 向前定位', () => {
  it('对任意页尾位置，都能找到放得下、且不早于 end - 2C 的上一页起点', () => {
    const opts = { charsPerLine: 15, linesPerPage: 5 }
    const m = makeFakeMeasurer(NOVEL, opts)
    const pm = new PageMap(NOVEL, m)
    const cap = opts.charsPerLine * opts.linesPerPage
    for (let i = 1; i <= 30; i++) {
      const end = Math.floor((NOVEL.length - 1) * (i / 30))
      if (end <= 0) continue
      const p = pm.prevStart(end)
      expect(p).toBeLessThan(end)
      expect(p).toBeGreaterThanOrEqual(end - 2 * cap - 1)
      expect(m.fits(p, end - p)).toBe(true)
    }
  })
})

describe('PageMap: 边界', () => {
  it('空文本：单页且不可翻动', () => {
    const pm = new PageMap('', makeFakeMeasurer('', { charsPerLine: 10, linesPerPage: 5 }))
    expect(pm.totalChars).toBe(0)
    expect(pm.current).toEqual({ start: 0, end: 0 })
    expect(pm.atLastPage).toBe(true)
    expect(pm.goNext()).toBe(false)
    pm.jumpTo(100)
    expect(pm.current).toEqual({ start: 0, end: 0 })
  })

  it('单字符文本', () => {
    const pm = new PageMap('书', makeFakeMeasurer('书', { charsPerLine: 10, linesPerPage: 5 }))
    expect(pm.current).toEqual({ start: 0, end: 1 })
    expect(pm.atLastPage).toBe(true)
    expect(pm.pageText()).toBe('书')
  })

  it('连续短行（大量换行）不会产生空页或死循环', () => {
    const text = Array(500).fill('短').join('\n')
    const pm = new PageMap(text, makeFakeMeasurer(text, { charsPerLine: 10, linesPerPage: 5 }))
    let guard = 0
    while (!pm.atLastPage && guard++ < text.length) {
      const prevEnd = pm.current.end
      expect(pm.goNext()).toBe(true)
      expect(pm.current.start).toBe(prevEnd)
      expect(pm.current.end).toBeGreaterThan(prevEnd)
    }
    expect(pm.current.end).toBe(text.length)
  })
})

describe('PageMap: 百万字规模', () => {
  it('百万字符小说可即时跳转并翻到末尾，页界铺满全文', () => {
    const text = makeNovelText(20000) // 约 200 万字符
    expect(text.length).toBeGreaterThan(1_000_000)
    const pm = new PageMap(text, makeFakeMeasurer(text, { charsPerLine: 24, linesPerPage: 8 }))

    pm.jumpTo(Math.floor(text.length * 0.8))
    expect(pm.current.start).toBeLessThanOrEqual(Math.floor(text.length * 0.8))
    expect(pm.current.end).toBeGreaterThan(Math.floor(text.length * 0.8))

    let pages = 1
    while (!pm.atLastPage && pages < text.length) {
      pm.goNext()
      pages++
    }
    expect(pm.current.end).toBe(text.length)
  })
})
