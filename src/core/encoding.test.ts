/**
 * encoding.ts 单元测试（技术方案 §5）。
 * 覆盖：UTF-8 / GBK / GB18030 四字节 / UTF-16 / 带 BOM 的字节流探测与解码。
 */
import { describe, expect, it } from 'vitest'
import { decodeText } from './encoding'

const utf8 = (s: string) => new TextEncoder().encode(s)

describe('decodeText: UTF-8', () => {
  it('解码无 BOM 的 UTF-8 中文', () => {
    const r = decodeText(utf8('你好，世界。abc 123'))
    expect(r.text).toBe('你好，世界。abc 123')
    expect(r.charset).toBe('utf-8')
  })

  it('剥除 UTF-8 BOM', () => {
    const body = utf8('BOM 测试文本')
    const bytes = new Uint8Array(3 + body.length)
    bytes.set([0xef, 0xbb, 0xbf], 0)
    bytes.set(body, 3)
    const r = decodeText(bytes)
    expect(r.text).toBe('BOM 测试文本')
    expect(r.charset).toBe('utf-8')
  })

  it('纯 ASCII 文本判定为 UTF-8', () => {
    const r = decodeText(utf8('plain ascii text\r\nline2'))
    expect(r.charset).toBe('utf-8')
    expect(r.text).toBe('plain ascii text\r\nline2')
  })
})

describe('decodeText: GBK / GB18030', () => {
  it('GBK 字节自动识别并正确解码（中文关键场景）', () => {
    // 「你好，世界。」的 GBK 编码字节
    const bytes = Uint8Array.from([
      0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7, 0xa1, 0xa3,
    ])
    const r = decodeText(bytes)
    expect(r.text).toBe('你好，世界。')
    expect(r.charset).toBe('gb18030')
  })

  it('混排中英文的 GBK 文本不乱码', () => {
    // 「第1章 初雪」的 GBK 编码
    const bytes = Uint8Array.from([
      0xb5, 0xda, 0x31, 0xd5, 0xc2, 0x20, 0xb3, 0xf5, 0xd1, 0xa9,
    ])
    const r = decodeText(bytes)
    expect(r.text).toBe('第1章 初雪')
  })

  it('GB18030 四字节字符（生僻字 𠮷）不丢字', () => {
    // U+20BB7 的 GB18030 编码；该字节序列不是合法 UTF-8，必然走 GB18030 通道
    const bytes = Uint8Array.from([0x95, 0x34, 0xb2, 0x35])
    const r = decodeText(bytes)
    expect(r.text).toBe('𠮷')
    expect(r.charset).toBe('gb18030')
  })

  it('GBK 字节整体不是合法 UTF-8，必须走 GB18030 通道', () => {
    // 「深」GBK = 0xC9 0xEE；单独的 0xC9 0x32 是合法 UTF-8（É2），
    // 所以这里用多个连续双字节序列保证严格 UTF-8 解码必然失败
    const bytes = Uint8Array.from([0xc4, 0xe3, 0xba, 0xc3])
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow()
    expect(decodeText(bytes).text).toBe('你好')
  })
})

describe('decodeText: UTF-16', () => {
  it('UTF-16LE 带 BOM', () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59]) // "你好" LE
    const r = decodeText(bytes)
    expect(r.text).toBe('你好')
    expect(r.charset).toBe('utf-16le')
  })

  it('UTF-16BE 带 BOM', () => {
    const bytes = Uint8Array.from([0xfe, 0xff, 0x4f, 0x60, 0x59, 0x7d]) // "你好" BE
    const r = decodeText(bytes)
    expect(r.text).toBe('你好')
    expect(r.charset).toBe('utf-16be')
  })
})

describe('decodeText: 兜底', () => {
  it('非法字节流不抛异常', () => {
    const r = decodeText(Uint8Array.from([0xff, 0xfe, 0x00, 0x01]))
    expect(typeof r.text).toBe('string')
  })

  it('空输入返回空字符串', () => {
    const r = decodeText(new Uint8Array(0))
    expect(r.text).toBe('')
  })
})
