/**
 * importers 测试（V5.0）：ZIP 读取、HTML/EPUB 文本抽取、Markdown、格式探测。
 * 合成 EPUB 由测试自行构造（zlib deflate + ZIP 结构），保证离线可测。
 */
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { readZipDirectory, readZipEntry, ZipError } from './zip'
import { decodeEntities, htmlToText, looksLikeHtml } from './html'
import { parseMarkdown, stripInlineMd } from './markdown'
import { detectFormat, importBook, ImportError } from './index'
import { parseNcx, parseOpf, resolvePath } from './epub'

// ---------- 合成 ZIP ----------

interface FileSpec {
  name: string
  content: string | Uint8Array
  method?: 0 | 8
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 构造一个最小可用的 ZIP（本地头 + 中央目录 + EOCD）。 */
export function buildZip(files: FileSpec[]): ArrayBuffer {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const f of files) {
    const nameBytes = encoder.encode(f.name)
    const data = typeof f.content === 'string' ? encoder.encode(f.content) : f.content
    const method = f.method ?? 8
    const stored = method === 8 ? new Uint8Array(deflateRawSync(data)) : data
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.length + stored.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version
    lv.setUint16(8, method, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, stored.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(stored, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, method, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, stored.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length
  }

  const cdSize = centrals.reduce((s, c) => s + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)

  const total = offset + cdSize + eocd.length
  const out = new Uint8Array(total)
  let p = 0
  for (const l of locals) {
    out.set(l, p)
    p += l.length
  }
  for (const c of centrals) {
    out.set(c, p)
    p += c.length
  }
  out.set(eocd, p)
  return out.buffer
}

// ---------- 合成 EPUB ----------

function buildEpub(opts: { chapters: Array<{ id: string; title: string; html: string }>; withNav?: boolean }) {
  const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

  const manifestItems = opts.chapters
    .map((c) => `<item id="${c.id}" href="text/${c.id}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n    ')
  const spineItems = opts.chapters.map((c) => `<itemref idref="${c.id}"/>`).join('\n    ')

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试之书</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>
    ${manifestItems}
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc"><ol>
${opts.chapters.map((c) => `<li><a href="text/${c.id}.xhtml">${c.title}</a></li>`).join('\n')}
</ol></nav></body></html>`

  const files: FileSpec[] = [
    { name: 'mimetype', content: 'application/epub+zip', method: 0 },
    { name: 'META-INF/container.xml', content: container },
    { name: 'OEBPS/content.opf', content: opf },
    { name: 'OEBPS/nav.xhtml', content: nav },
    ...opts.chapters.map((c) => ({
      name: `OEBPS/text/${c.id}.xhtml`,
      content: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${c.title}</title></head>
<body>${c.html}</body></html>`,
    })),
  ]
  return buildZip(files)
}

const SAMPLE_CHAPTERS = [
  {
    id: 'ch1',
    title: '第一章 起风',
    html: '<h1>第一章 起风</h1><p>他站在山巅，风从谷底吹上来。</p><p>远方的云正在聚拢&amp;散开。</p>',
  },
  {
    id: 'ch2',
    title: '第二章 落雨',
    html: '<h1>第二章 落雨</h1><p>雨点敲在瓦上，像谁在敲着旧鼓。</p><p>他想起许多年前的那个傍晚。</p>',
  },
  {
    id: 'ch3',
    title: '第三章 归途',
    html: '<h1>第三章 归途</h1><p>路很长，但他并不着急。</p>',
  },
]

// ---------- ZIP ----------

describe('zip: 读取', () => {
  it('列出条目并能按名取回内容（deflate 与存储两种）', async () => {
    const buf = buildZip([
      { name: 'a.txt', content: 'hello 世界' },
      { name: 'b.txt', content: 'stored content', method: 0 },
    ])
    const entries = readZipDirectory(buf)
    expect(entries.map((e) => e.name).sort()).toEqual(['a.txt', 'b.txt'])

    const a = entries.find((e) => e.name === 'a.txt')!
    const b = entries.find((e) => e.name === 'b.txt')!
    expect(new TextDecoder().decode(await readZipEntry(buf, a))).toBe('hello 世界')
    expect(new TextDecoder().decode(await readZipEntry(buf, b))).toBe('stored content')
  })

  it('非 ZIP 文件报可读错误', () => {
    const buf = new TextEncoder().encode('这不是 zip').buffer
    expect(() => readZipDirectory(buf as ArrayBuffer)).toThrow(ZipError)
  })
})

// ---------- HTML ----------

describe('html: 文本抽取', () => {
  it('块级标签转换行、去标签、解码实体', () => {
    const r = htmlToText('<p>第一段</p><p>第二段 &amp; 更多</p>')
    expect(r.text).toBe('第一段\n\n第二段 & 更多')
  })

  it('丢弃 script/style，保留标题', () => {
    const r = htmlToText('<script>var a=1</script><style>.x{}</style><h2>小标题</h2><p>正文</p>')
    expect(r.text).not.toContain('var a')
    expect(r.text).not.toContain('.x{}')
    expect(r.headings).toEqual(['小标题'])
  })

  it('解码各类实体（命名/十进制/十六进制）', () => {
    expect(decodeEntities('&nbsp;&#65;&#x4e2d;&hellip;')).toBe(' A中…')
  })

  it('折叠多余空行', () => {
    const r = htmlToText('<p>甲</p><br><br><br><p>乙</p>')
    expect(r.text).toBe('甲\n\n乙')
  })

  it('looksLikeHtml 判别', () => {
    expect(looksLikeHtml('<!DOCTYPE html><html><body>x</body></html>')).toBe(true)
    expect(looksLikeHtml('普通文本，没有标签')).toBe(false)
  })
})

// ---------- Markdown ----------

describe('markdown: 解析', () => {
  it('标题进目录并记录偏移，行内标记剥离', () => {
    const md = '# 第一章\n\n这是 **粗体** 与 `代码`。\n\n## 小节\n\n[链接](http://x) 文字'
    const r = parseMarkdown(md)
    expect(r.title).toBe('第一章')
    expect(r.tocEntries.map((t) => t.title)).toEqual(['第一章', '小节'])
    expect(r.text).toContain('这是 粗体 与 代码。')
    expect(r.text).toContain('链接 文字')
    for (const t of r.tocEntries) {
      expect(r.text.slice(t.charIndex, t.charIndex + t.title.length)).toBe(t.title)
    }
  })

  it('代码围栏内容保留、围栏行丢弃', () => {
    const r = parseMarkdown('文本\n```js\nconst a = 1\n```\n结束')
    expect(r.text).toContain('const a = 1')
    expect(r.text).not.toContain('```')
  })

  it('引用与列表去前缀保留内容', () => {
    const r = parseMarkdown('> 引用一句\n- 列表项\n1. 有序项')
    expect(r.text).toContain('引用一句')
    expect(r.text).toContain('列表项')
    expect(r.text).toContain('有序项')
    expect(r.text).not.toContain('- ')
  })

  it('stripInlineMd 处理图片与删除线', () => {
    expect(stripInlineMd('![图](a.png)~~删除~~')).toBe('图删除')
  })
})

// ---------- 格式探测与不支持格式 ----------

describe('detectFormat / 不支持格式', () => {
  it('按魔数识别 EPUB（zip）', () => {
    const zip = new Uint8Array(buildZip([{ name: 'x', content: 'y' }]))
    expect(detectFormat('book.epub', zip)).toBe('epub')
    expect(detectFormat('unknown.bin', zip)).toBe('epub')
  })

  it('按扩展名识别 md/html', () => {
    const empty = new Uint8Array([1, 2, 3])
    expect(detectFormat('a.md', empty)).toBe('md')
    expect(detectFormat('a.html', empty)).toBe('html')
    expect(detectFormat('a.txt', empty)).toBe('txt')
  })

  it('PDF 走独立通道（V6.0），损坏文件抛 ImportError；MOBI 仍明确不支持', async () => {
    // V6.0：PDF 不再被 assertSupported 拦截，而是进入 importPdf 的解析分支；
    // 损坏文件在 pdf.js 内抛 InvalidPDFException，由 importPdf 归一为 ImportError。
    const pdf = new TextEncoder().encode('%PDF-1.7 corrupted body')
    const err = await importBook('x.pdf', pdf.buffer as ArrayBuffer).catch((e) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect(err.message).toBe('PDF 解析失败')

    const mobi = new Uint8Array([0x42, 0x4f, 0x4f, 0x4b, 0, 0])
    await expect(importBook('x.mobi', mobi.buffer as ArrayBuffer)).rejects.toThrow('MOBI')
  })
})

// ---------- EPUB 端到端（合成） ----------

describe('epub: 端到端导入', () => {
  it('解析章节顺序、目录偏移、元信息', async () => {
    const buf = buildEpub({ chapters: SAMPLE_CHAPTERS })
    const r = await importBook('测试.epub', buf)

    expect(r.format).toBe('epub')
    expect(r.title).toBe('测试之书')
    expect(r.author).toBe('测试作者')
    expect(r.language).toBe('zh')

    // 章节标题来自 nav 目录，且偏移指向正文中的标题行
    expect(r.tocEntries?.map((t) => t.title)).toEqual([
      '第一章 起风',
      '第二章 落雨',
      '第三章 归途',
    ])
    for (const t of r.tocEntries!) {
      expect(r.text.slice(t.charIndex, t.charIndex + t.title.length)).toBe(t.title)
    }
    // 章节顺序与内容
    expect(r.text).toContain('他站在山巅')
    expect(r.text).toContain('雨点敲在瓦上')
    const i1 = r.text.indexOf('第一章')
    const i2 = r.text.indexOf('第二章')
    const i3 = r.text.indexOf('第三章')
    expect(i1).toBeLessThan(i2)
    expect(i2).toBeLessThan(i3)
    // 实体已解码
    expect(r.text).toContain('云正在聚拢&散开')
    expect(r.warnings).toEqual([])
  })

  it('单章内容为空（损坏页/空白页）时跳过该章并记入 warnings，其余照常导入', async () => {
    // 空白章：body 无任何内容，且不存在 <title>（避免 title 被当作正文）
    const buf = buildEpub({
      chapters: [
        SAMPLE_CHAPTERS[0],
        { id: 'ch2', title: '', html: '' },
        SAMPLE_CHAPTERS[2],
      ],
    })
    const r = await importBook('测试.epub', buf)
    expect(r.warnings.some((w) => w.includes('第 2 章'))).toBe(true)
    expect(r.text).toContain('他站在山巅') // 第一章仍在
    expect(r.text).toContain('路很长') // 第三章仍在
    // 跳过的章节不应进入目录
    expect(r.tocEntries?.length).toBe(2)
  })

  it('缺少 container.xml 时回退搜索 .opf', async () => {
    const zip = buildZip([
      { name: 'OEBPS/book.opf', content: '<package><manifest><item id="c1" href="1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>' },
      { name: 'OEBPS/1.xhtml', content: '<html><body><p>唯一一章的内容</p></body></html>' },
    ])
    const r = await importBook('x.epub', zip)
    expect(r.text).toContain('唯一一章的内容')
    expect(r.warnings.some((w) => w.includes('目录'))).toBe(true)
  })

  it('没有正文的 EPUB 抛可读错误', async () => {
    const zip = buildZip([{ name: 'META-INF/container.xml', content: '<container><rootfiles><rootfile full-path="x.opf"/></rootfiles></container>' }])
    await expect(importBook('x.epub', zip)).rejects.toThrow(ImportError)
  })
})

// ---------- OPF / NCX / 路径 ----------

describe('epub: OPF 与 NCX 解析', () => {
  it('parseOpf 提取 manifest/spine/metadata/封面', () => {
    const opf = `<package><metadata xmlns:dc="x"><dc:title>书名</dc:title><dc:creator>作者</dc:creator>
      <meta name="cover" content="cov"/></metadata>
      <manifest><item id="cov" href="images/c.jpg" media-type="image/jpeg"/>
      <item id="c1" href="t/1.xhtml" media-type="application/xhtml+xml"/></manifest>
      <spine><itemref idref="c1"/></spine></package>`
    const r = parseOpf(opf)
    expect(r.title).toBe('书名')
    expect(r.author).toBe('作者')
    expect(r.spine).toEqual(['c1'])
    expect(r.coverId).toBe('cov')
    expect(r.manifest).toHaveLength(2)
  })

  it('parseNcx 提取章节标题与路径', () => {
    const ncx = `<ncx><navMap>
      <navPoint><navLabel><text>第一回</text></navLabel><content src="text/1.xhtml"/></navPoint>
      <navPoint><navLabel><text>第二回</text></navLabel><content src="text/2.xhtml#p"/></navPoint>
    </navMap></ncx>`
    const map = parseNcx(ncx, 'OEBPS/toc.ncx')
    expect(map.get('OEBPS/text/1.xhtml')).toBe('第一回')
    expect(map.get('OEBPS/text/2.xhtml')).toBe('第二回')
  })

  it('resolvePath 处理相对路径与 ../', () => {
    expect(resolvePath('OEBPS/content.opf', 'text/1.xhtml')).toBe('OEBPS/text/1.xhtml')
    expect(resolvePath('OEBPS/sub/a.xhtml', '../images/c.png')).toBe('OEBPS/images/c.png')
    expect(resolvePath('content.opf', './a.xhtml')).toBe('a.xhtml')
  })
})
