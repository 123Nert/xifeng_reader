/**
 * toc.ts 单元测试：内置模式切分、自定义正则、开篇补全、当前章节定位。
 */
import { describe, expect, it } from 'vitest'
import { buildToc, currentChapterIndex, splitLinesWithOffsets } from './toc'

/** 用段落构造文本，同时拿到每段起始偏移，避免手算。 */
function build(segments: string[]): { text: string; starts: number[] } {
  let text = ''
  const starts: number[] = []
  for (const s of segments) {
    starts.push(text.length)
    text += s + '\r\n\r\n'
  }
  return { text, starts }
}

describe('buildToc: 内置模式', () => {
  it('识别"第X章/回"与"卷一"（中文数字与阿拉伯数字），charIndex 指向行首', () => {
    const { text, starts } = build([
      '一段没有章节标题的序言。',
      '第一章 山中岁月',
      '这是第一章的正文，讲了一些故事。',
      '第二章 下山',
      '第二章正文。',
      '第100章 大结局',
    ])
    const toc = buildToc(text)
    expect(toc.source).toBe('builtin')
    expect(toc.entries.map((e) => e.title)).toEqual([
      '开篇', // 首章之前的正文不算章节，补"开篇"
      '第一章 山中岁月',
      '第二章 下山',
      '第100章 大结局',
    ])
    expect(toc.entries.map((e) => e.charIndex)).toEqual([0, starts[1], starts[3], starts[5]])
  })

  it('首章就在文本开头时不补"开篇"', () => {
    const { text } = build(['第一章 直接开始', '正文。'])
    const toc = buildToc(text)
    expect(toc.entries.map((e) => e.title)).toEqual(['第一章 直接开始'])
    expect(toc.entries[0].charIndex).toBe(0)
  })

  it('识别"楔子"等特殊章节与"第三回""卷一"式标题', () => {
    const { text } = build(['楔子', '楔子正文。', '第三回 风雪山神庙', '正文。', '卷一 起势', '正文。'])
    const titles = buildToc(text).entries.map((e) => e.title)
    expect(titles).toContain('楔子')
    expect(titles).toContain('第三回 风雪山神庙')
    expect(titles).toContain('卷一 起势')
  })

  it('"第一章"开头的长正文行不会被误认为章节', () => {
    const long = '第一章' + '今天天气很好'.repeat(20)
    const { text } = build([long, '第二章 正常章节', '正文。'])
    const titles = buildToc(text).entries.map((e) => e.title)
    expect(titles).not.toContain(long)
    expect(titles).toContain('第二章 正常章节')
  })

  it('没有任何章节时优雅降级', () => {
    const toc = buildToc('只是一段普通文字，没有章节标题。')
    expect(toc.entries).toEqual([])
    expect(toc.source).toBe('none')
  })

  it('空文本返回空目录', () => {
    expect(buildToc('')).toEqual({ entries: [], source: 'none' })
  })
})

describe('buildToc: 自定义正则', () => {
  it('自定义正则优先于内置模式（纯数字行作为章节）', () => {
    const { text, starts } = build(['1', '第一段正文。', '2', '第二段正文。'])
    const toc = buildToc(text, '^\\d+$')
    expect(toc.source).toBe('custom')
    // 首个章节就在文本开头，因此没有"开篇"条目
    expect(toc.entries).toEqual([
      { title: '1', charIndex: starts[0] },
      { title: '2', charIndex: starts[2] },
    ])
  })

  it('无效正则返回错误信息', () => {
    const toc = buildToc('正文', '第[')
    expect(toc.entries).toEqual([])
    expect(toc.error).toContain('正则表达式无效')
  })
})

describe('splitLinesWithOffsets', () => {
  it('兼容 \\r\\n 与 \\n，偏移指向每行首字符', () => {
    const text = 'ab\r\ncd\nef'
    const lines = splitLinesWithOffsets(text)
    expect(lines.map((l) => [l.text, l.start])).toEqual([
      ['ab', 0],
      ['cd', 4],
      ['ef', 7],
    ])
  })
})

describe('currentChapterIndex', () => {
  const entries = [
    { title: '开篇', charIndex: 0 },
    { title: '第一章', charIndex: 100 },
    { title: '第二章', charIndex: 500 },
  ]

  it('返回最后一个起点 <= 目标位置的章节', () => {
    expect(currentChapterIndex(entries, 0)).toBe(0)
    expect(currentChapterIndex(entries, 99)).toBe(0)
    expect(currentChapterIndex(entries, 100)).toBe(1)
    expect(currentChapterIndex(entries, 499)).toBe(1)
    expect(currentChapterIndex(entries, 99999)).toBe(2)
  })

  it('空目录返回 -1', () => {
    expect(currentChapterIndex([], 5)).toBe(-1)
  })
})
