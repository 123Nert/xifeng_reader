// 用真实生成的 demo.epub/md/html 验证导入管线
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { importBook } from './index'

function load(name: string): ArrayBuffer {
  const buf = readFileSync(`public/${name}`)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

describe('真实文件导入', () => {
  it('EPUB：标题/作者/章节/封面/正文', async () => {
    const r = await importBook('demo.epub', load('demo.epub'))
    expect(r.format).toBe('epub')
    expect(r.title).toBe('山中旧信')
    expect(r.author).toBe('佚名')
    expect(r.tocEntries?.map((t) => t.title)).toEqual([
      '第一章 山中来客', '第二章 旧信', '第三章 夜谈', '第四章 归途',
    ])
    expect(r.text).toContain('暮色四合时')
    expect(r.text).toContain('远到我已经记不清来路了')
    // 目录偏移准确
    for (const t of r.tocEntries!) {
      expect(r.text.slice(t.charIndex, t.charIndex + t.title.length)).toBe(t.title)
    }
    // 封面为 SVG data URL
    expect(r.cover?.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(r.warnings).toEqual([])
  })

  it('Markdown：标题进目录、代码块保留、链接剥离', async () => {
    const r = await importBook('demo.md', load('demo.md'))
    expect(r.format).toBe('md')
    expect(r.title).toBe('草稿本')
    expect(r.tocEntries?.map((t) => t.title)).toEqual(['草稿本', '第一节 关于风', '第二节 关于雨'])
    expect(r.text).toContain('风是看不见的')
    expect(r.text).toContain('世界忽然变得很安静')
    expect(r.text).toContain("const wind = 'wind'")
    expect(r.text).not.toContain('```')
  })

  it('HTML：标题进目录、实体解码', async () => {
    const r = await importBook('demo.html', load('demo.html'))
    expect(r.format).toBe('html')
    expect(r.tocEntries?.map((t) => t.title)).toEqual(['第一章 网页文本', '第二章 小节标题'])
    expect(r.text).toContain('包含 & 实体与 粗体 标记')
  })
})
