/**
 * purify.ts 单元测试：推广行删除、正文保护、结构保留。
 */
import { describe, expect, it } from 'vitest'
import { purifyText } from './purify'

describe('purifyText', () => {
  it('删除含网址的推广行', () => {
    const text = '第一章 开端\r\n本书来自 www.biquge.com 请记住本站\r\n正文第一段。'
    const r = purifyText(text)
    expect(r.removed).toBe(1)
    expect(r.text).not.toContain('biquge')
    expect(r.text).toContain('第一章 开端')
    expect(r.text).toContain('正文第一段。')
  })

  it('删除求票/宣传类短行', () => {
    const text = '正文。\n【求收藏，求月票！】\n天才一秒记住本站地址：xx.com\n下一段。'
    const r = purifyText(text)
    expect(r.removed).toBe(2)
    expect(r.text).toContain('正文。')
    expect(r.text).toContain('下一段。')
  })

  it('包含关键词的长正文行不会被误删', () => {
    const long = '他说现在很多网站都有广告，可这一段是正文，足足有八十字以上，只要这行足够长就不会被当成推广行处理掉，继续写一些字数来确保长度超过限制，比如再谈谈天气、山水与人物。'
    const r = purifyText(`前一段。\n${long}\n后一段。`)
    expect(r.removed).toBe(0)
    expect(r.text).toContain(long)
  })

  it('干净文本原样返回', () => {
    const text = '第一章\n\n　　正文内容，没有任何广告。'
    const r = purifyText(text)
    expect(r.removed).toBe(0)
    expect(r.text).toBe(text)
  })

  it('空文本安全', () => {
    expect(purifyText('')).toEqual({ text: '', removed: 0 })
  })

  it('删除行后保留其余行的换行结构', () => {
    const text = 'A\n广告：www.x.com\nB\nC'
    const r = purifyText(text)
    expect(r.text.split('\n')).toEqual(['A', 'B', 'C'])
  })
})
