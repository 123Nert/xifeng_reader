/**
 * search.ts 单元测试：命中偏移、大小写、摘要、上限与边界。
 */
import { describe, expect, it } from 'vitest'
import { searchText } from './search'

describe('searchText', () => {
  const text = '山高水长，岁月悠长。\r\n长河落日圆，长风万里。'

  it('找到全部命中且偏移可用原文验证', () => {
    const hits = searchText(text, '长')
    expect(hits).toHaveLength(4)
    for (const h of hits) {
      expect(text.slice(h.charIndex, h.charIndex + h.length)).toBe('长')
    }
  })

  it('多字词命中，偏移与长度正确', () => {
    const hits = searchText(text, '长河')
    expect(hits).toHaveLength(1)
    expect(text.slice(hits[0].charIndex, hits[0].charIndex + 2)).toBe('长河')
  })

  it('英文忽略大小写', () => {
    const hits = searchText('Hello World, hello again.', 'hello')
    expect(hits).toHaveLength(2)
    expect(hits[0].charIndex).toBe(0)
    expect(hits[1].charIndex).toBe(13)
  })

  it('摘要折叠空白并截取命中上下文', () => {
    const hits = searchText(text, '落日')
    expect(hits[0].excerpt).toContain('长河落日圆')
    expect(hits[0].excerpt).not.toMatch(/\r|\n/)
  })

  it('无命中与空查询返回空数组', () => {
    expect(searchText(text, '不存在的词')).toEqual([])
    expect(searchText(text, '   ')).toEqual([])
    expect(searchText('', '长')).toEqual([])
  })

  it('limit 限制结果条数', () => {
    const lots = '长'.repeat(1000)
    expect(searchText(lots, '长', 10)).toHaveLength(10)
  })

  it('重叠命中不漏报（逐位推进）', () => {
    // "aa" 在 "aaa" 中命中 2 次（位置 0 与 1）
    expect(searchText('aaa', 'aa').map((h) => h.charIndex)).toEqual([0, 1])
  })
})
