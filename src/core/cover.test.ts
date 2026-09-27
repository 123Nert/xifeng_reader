/**
 * cover.ts 单元测试：封面摘录与折行（纯函数部分）。
 *
 * canvas 绘制只在浏览器里跑（Node 无 DOM canvas，函数会返回 null 由调用方回退），
 * 这里覆盖"选标题 / 折行 / 截断 / 版面参数"这些容易出错的规则。
 */
import { describe, expect, it } from 'vitest'
import { COVER_HEIGHT, COVER_WIDTH, coverExcerpt, coverLayout, wrapByWidth } from './cover'

const LAYOUT = coverLayout(COVER_WIDTH)

describe('cover: 版面参数', () => {
  it('封面比例与 .book-cover 一致（5:7）', () => {
    expect(COVER_WIDTH / COVER_HEIGHT).toBeCloseTo(5 / 7, 3)
  })

  it('版心随宽度等比推导', () => {
    const small = coverLayout(200)
    expect(small.padding).toBe(Math.round(COVER_WIDTH * 0.09 / 2))
    expect(small.fontSize).toBeLessThan(LAYOUT.fontSize)
    expect(small.charsPerLine).toBeLessThan(LAYOUT.charsPerLine)
    expect(small.maxLines).toBeLessThan(LAYOUT.maxLines)
  })

  it('参数不会退化成 0（极窄尺寸也安全）', () => {
    const tiny = coverLayout(1)
    expect(tiny.charsPerLine).toBeGreaterThanOrEqual(1)
    expect(tiny.maxLines).toBeGreaterThanOrEqual(1)
  })
})

describe('cover: 折行', () => {
  it('按全角字数断行', () => {
    const r = wrapByWidth('一二三四五六七八九十', 5, 10)
    expect(r.lines).toEqual(['一二三四五', '六七八九十'])
    expect(r.truncated).toBe(false)
  })

  it('半角字符按 0.55 字宽计（一行能放更多）', () => {
    const r = wrapByWidth('abcdefghij', 5, 10)
    // 5 / 0.55 ≈ 9 个半角字符一行
    expect(r.lines[0].length).toBeGreaterThan(5)
    expect(r.lines.join('')).toBe('abcdefghij')
  })

  it('超出最大行数时标记截断', () => {
    const r = wrapByWidth('一二三四五六七八九十一二三四五六七八九十', 5, 2)
    expect(r.lines).toHaveLength(2)
    expect(r.truncated).toBe(true)
  })

  it('行首不留空格、行尾剪空白', () => {
    const r = wrapByWidth('一二三  四五', 3, 5)
    expect(r.lines.every((l) => !l.startsWith(' '))).toBe(true)
    expect(r.lines.every((l) => l === l.trimEnd())).toBe(true)
  })

  it('空输入得到空结果', () => {
    expect(wrapByWidth('', 10, 3)).toEqual({ lines: [], truncated: false })
  })
})

describe('cover: 摘录', () => {
  const novel = [
    '第一章 山中旧信',
    '暮色四合时，山道上走来一个旅人。他抬头望了望天，云层压得很低。',
    '村口的灯一盏盏亮起来，他加快了脚步。',
    '老人给他倒了一碗热茶，说起从前的事。',
  ].join('\n')

  it('首行短且有正文 → 当标题，正文从第二段开始', () => {
    const r = coverExcerpt(novel, LAYOUT)
    expect(r.title).toBe('第一章 山中旧信')
    expect(r.lines.join('')).toContain('暮色四合时')
    expect(r.lines.join('')).not.toContain('第一章')
  })

  it('首行很长（不是标题）时全部当正文', () => {
    const longFirst = '暮色四合时，山道上走来一个旅人。他抬头望了望天，云层压得很低很低，像是要把整个村子都盖住。'
    const r = coverExcerpt(`${longFirst}\n第二段。`, LAYOUT)
    expect(r.title).toBeNull()
    expect(r.lines.join('')).toContain('暮色四合时')
  })

  it('只有一段时不设标题', () => {
    const r = coverExcerpt('只有一段话。', LAYOUT)
    expect(r.title).toBeNull()
    expect(r.lines).toHaveLength(1)
  })

  it('内容远超版面时截断，且行数不超上限', () => {
    const huge = Array.from({ length: 50 }, (_, i) => `第${i}段：这是一段用来撑满封面的正文内容。`).join('\n')
    const r = coverExcerpt(huge, LAYOUT)
    expect(r.truncated).toBe(true)
    expect(r.lines.length).toBeLessThanOrEqual(LAYOUT.maxLines)
  })

  it('空正文返回空结果（调用方回退渐变封面）', () => {
    expect(coverExcerpt('   \n\n  ', LAYOUT)).toEqual({ title: null, lines: [], truncated: false })
  })

  it('CRLF 与多余空行不影响摘录', () => {
    const r = coverExcerpt(
      '第一章 山\r\n\r\n\r\n暮色四合时，山道上走来一个旅人。他抬头望了望天，云层压得很低。\r\n村口的灯一盏盏亮起来，他加快了脚步。',
      LAYOUT,
    )
    expect(r.title).toBe('第一章 山')
    expect(r.lines.every((l) => !l.includes('\r'))).toBe(true)
  })

  it('紧挨着的重复段落只保留一次（网文 TXT 的分页残留）', () => {
    const body = '雪落无声。他推开门，风灌了进来，屋里的灯晃了一下。'
    const r = coverExcerpt(`第一章 雪\n${body}\n${body}\n${body}`, LAYOUT)
    expect(r.lines.join('').split('雪落无声').length - 1).toBe(1)
  })

  it('短行重复不折叠（对话里的重复很正常）', () => {
    const dialog = ['「你来了。」', '「我来了。」', '「你来了。」'].join('\n')
    const r = coverExcerpt(dialog, LAYOUT)
    expect(r.lines.join('').split('你来了').length - 1).toBe(2)
  })

  it('正文开头连排章节标题时，封面止步于第一章正文（不画成目录页）', () => {
    const body = '暮色四合，远山如黛。少年收拾行囊，踏上了北去的官道，心中满是未卜的前程。'
    const text = [
      '第1回 风雪夜行',
      body,
      '第2回 风雪夜行',
      body,
      '第3回 风雪夜行',
      body,
    ].join('\n')
    const r = coverExcerpt(text, LAYOUT)
    // 标题取第一章标题，正文只有一段（后面的回目不再进封面）
    expect(r.title).toBe('第1回 风雪夜行')
    expect(r.lines.join('')).toContain('暮色四合')
    expect(r.lines.join('')).not.toContain('第2回')
    expect(r.lines.join('').split('暮色四合').length - 1).toBe(1)
  })

  it('标题在第一行、正文里还有后续章节标题时，只画第一章正文', () => {
    const text = [
      '草稿本',
      '第一节 关于风',
      '风是看不见的，但你能感觉到它。',
      '第二节 关于雨',
      '雨落下来的时候，世界忽然变得很安静。',
    ].join('\n')
    const r = coverExcerpt(text, LAYOUT)
    expect(r.title).toBe('草稿本')
    expect(r.lines.join('')).toContain('风是看不见的')
    expect(r.lines.join('')).not.toContain('第二节')
  })

  it('正文里没有章节标题时画满整屏（不因标题判断而提前截空）', () => {
    const body = Array.from({ length: 20 }, (_, i) => `第${i}句：这是一段普通正文，用来把封面填满。`).join('\n')
    const r = coverExcerpt(`某本集子\n${body}`, LAYOUT)
    expect(r.title).toBe('某本集子')
    expect(r.lines.length).toBeGreaterThan(5)
  })
})
