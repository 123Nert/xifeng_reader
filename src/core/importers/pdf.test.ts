/**
 * pdf.test.ts — V6.0 PDF 导入测试。
 *
 * 两层：
 * - 纯函数单测（assemblePageText / looksScanned / chooseToc / pageTocEntries）：
 *   合成 item 数组，断言行/段/空行/CJK-空格行为；
 * - 集成测试：真实跑 pdf.js 解析 test-fixtures 下的样本 PDF。
 *   - sample-cn.pdf：3 页中文小说 → 章节识别优先 + 段落组装；
 *   - sample-1page.pdf：1 页中文（来自 sample-cn 第一页），用 CJK Type0 + 预定义 CMap ——
 *     必须有 cMapUrl 才能解出文字（否则会拿到空 items）；
 *   - sample-encrypted.pdf：密码保护 → 必须报"有密码保护"，而不是"已损坏"。
 *
 * 集成测试在 Node 环境跑 pdf.js legacy 构建 + node_modules 下的 cmaps/standard_fonts，
 * 与脚本 scripts/sync-pdfjs-assets.mjs 铺到 public/pdfjs/ 的资源同源（同一 pdfjs-dist 包）。
 *
 * 关于 sample-cmap.pdf：它是「1 页 + 4 个汉字」的最小样本，能验证 cMap 通路但
 * 总字符数 4 < SCANNED_THRESHOLD(=20)，会被 importPdf 合理判为"扫描版"。
 * 该行为本身正确（一页只有 4 个字确实接近空文本），所以不再单独跑它做集成断言，
 * 改由 assemblePageText 单测 + sample-1page 集成测试覆盖 CMap 通路。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assemblePageText,
  chooseToc,
  importPdf,
  looksScanned,
  pageTocEntries,
  resolvePdfAssets,
  type PdfTextItem,
} from './pdf'
import { ImportError } from './types'

const FIXTURES = join(__dirname, '..', '..', '..', 'test-fixtures')

/** Node 的 Buffer 与独立 Uint8Array 内存布局不同 —— Buffer 是池化的（buffer 共享），
 * pdf.js 内部会检查 `value.byteLength === value.buffer.byteLength`，
 * 用 fs.readFileSync 直接拿到 Buffer 时该等式不成立，必须先 .slice 出独立 ArrayBuffer。
 */
function loadPdfBuffer(name: string): ArrayBuffer {
  const buf = readFileSync(join(FIXTURES, name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

// ---------- assemblePageText：行/段/空格的组装规则 ----------

describe('assemblePageText', () => {
  const item = (str: string, x: number, y: number, opts: Partial<PdfTextItem> = {}): PdfTextItem => ({
    str,
    transform: [1, 0, 0, 1, x, y],
    width: str.length * 10,
    height: 12,
    ...opts,
  })

  it('空输入 → 空字符串', () => {
    expect(assemblePageText([])).toBe('')
  })

  it('同 y 视为同一行，lines 内片段按 x 拼接', () => {
    // 两个片段在同一 y，但 x 紧邻 → 拼成一行
    const items = [item('第一', 0, 100), item('段落', 20, 100)]
    // 第二个片段 x=20，前一个 endX=0+20=20 → gap=0，无空格
    expect(assemblePageText(items)).toBe('第一段落')
  })

  it('y 差 >= 2 → 换行', () => {
    const items = [item('行一', 0, 100), item('行二', 0, 130)]
    expect(assemblePageText(items)).toBe('行一\n行二')
  })

  it('hasEOL 标记强制换行（即使 y 相同）', () => {
    const items = [
      item('行一', 0, 100, { hasEOL: true }),
      item('行二', 0, 100),  // y 与前一行相同！应由 hasEOL 触发换行
    ]
    expect(assemblePageText(items)).toBe('行一\n行二')
  })

  it('CJK 两侧无空格直接拼接', () => {
    // 间隙 5pt (≈ 0.42 × 字号 12) 不足以触发空格
    const items = [item('你好', 0, 100), item('世界', 40, 100)]
    // endX = 0 + 40 = 40，下一片段 x=40, gap=0 → 直接拼接
    expect(assemblePageText(items)).toBe('你好世界')
  })

  it('两侧都是拉丁字符且大间隙 → 补一个空格', () => {
    const items = [
      item('Hello', 0, 100, { width: 50 }),   // endX=50
      item('World', 60, 100, { width: 50 }),  // gap = 60-50 = 10 > max(1, 12*0.25)=3
    ]
    expect(assemblePageText(items)).toBe('Hello World')
  })

  it('CJK 与英文相邻时不补空格（紧贴样式）', () => {
    // gap 大，但前一段最后一字是中文 → 不补
    const items = [
      item('你好', 0, 100, { width: 40 }),
      item('World', 55, 100, { width: 50 }),
    ]
    expect(assemblePageText(items)).toBe('你好World')
  })

  it('相邻行（行间 y 间距差异 < 1.6×）保持连续，不插空行', () => {
    // 中文 PDF 段落通常行距均匀 —— 行间不插空行，仅靠 \n 分隔
    const items = [
      item('段一甲', 0, 100),
      item('段一乙', 0, 114),  // 行间 14，与下一段的间距相比 < 1.6 倍
      item('段二', 0, 130),
    ]
    expect(assemblePageText(items)).toBe('段一甲\n段一乙\n段二')
  })

  it('明显大于常规行距的 y 间距 → 段落之间插入空行', () => {
    // 三行：行距规律 14，但中间一行跳到 40（>> 14*1.6=22.4）→ 触发段落分隔
    // 注意：median 把所有"非平凡"行距都纳入，所以这里需要至少 3 个非平凡间距
    // 才能让那对"大间距"不被自己抬高基准。本例 gaps=[14, 16, 40]，median=16，40>16*1.6=25.6 ✓
    const items = [
      item('段一甲', 0, 100),
      item('段一乙', 0, 114),
      item('段一丙', 0, 130),
      item('段二', 0, 170),  // 间距 40，明显大于 16
    ]
    const out = assemblePageText(items)
    expect(out).toBe('段一甲\n段一乙\n段一丙\n\n段二')
  })

  it('单行不生成段落间隔', () => {
    expect(assemblePageText([item('唯一一行', 0, 100)])).toBe('唯一一行')
  })

  it('全空/空白片段被丢弃', () => {
    const items = [item('', 0, 100), item('  ', 0, 110), item('实际文字', 0, 130)]
    expect(assemblePageText(items)).toBe('实际文字')
  })

  it('缺 transform 时使用 [1,0,0,1,0,0] 兜底', () => {
    const items: PdfTextItem[] = [{ str: 'a' }, { str: 'b' }]
    expect(assemblePageText(items)).toBe('ab')
  })
})

// ---------- looksScanned：扫描版判定 ----------

describe('looksScanned', () => {
  it('总字符数 / 页数 < 20 判为扫描版', () => {
    expect(looksScanned(0, 5)).toBe(true)
    expect(looksScanned(50, 5)).toBe(true)     // 10/页
    expect(looksScanned(19 * 5, 5)).toBe(true) // 19/页
    expect(looksScanned(20 * 5, 5)).toBe(false) // 20/页，不视为扫描
    expect(looksScanned(200, 5)).toBe(false)
  })

  it('0 页直接视为扫描版（保护除零）', () => {
    expect(looksScanned(0, 0)).toBe(true)
  })
})

// ---------- chooseToc / pageTocEntries：目录策略 ----------

describe('pageTocEntries', () => {
  it('由每页起始偏移生成 "第 N 页" 目录', () => {
    expect(pageTocEntries([0, 50, 120])).toEqual([
      { title: '第 1 页', charIndex: 0 },
      { title: '第 2 页', charIndex: 50 },
      { title: '第 3 页', charIndex: 120 },
    ])
  })

  it('空页码表 → 空目录', () => {
    expect(pageTocEntries([])).toEqual([])
  })
})

describe('chooseToc', () => {
  const pageStarts = [0, 30, 60]

  it('识别到 >= 2 章 → 用章节目录（含可能的"开篇"）', () => {
    const text = '第一章 山\n\n内容。\n\n第二章 水\n\n内容。\n\n第三章 云\n\n内容。'
    const entries = chooseToc(text, pageStarts)
    const titles = entries.map((e) => e.title)
    expect(titles).toContain('第一章 山')
    expect(titles).toContain('第二章 水')
    expect(titles).toContain('第三章 云')
  })

  it('章节 < 2 章 → 回退页码目录', () => {
    const text = '没有任何章节标题\n\n只是连续的文本。\n\n第三章 这种不算 —— 因为只有一章'
    const entries = chooseToc(text, pageStarts)
    expect(entries).toEqual(pageTocEntries(pageStarts))
  })

  it('完全识别不到章节 → 回退页码目录', () => {
    const entries = chooseToc('一段普通文本，没有章节', pageStarts)
    expect(entries).toEqual(pageTocEntries(pageStarts))
  })
})

// ---------- 集成：真实 pdf.js + 仓内样本 ----------

describe('importPdf（真实样本）', () => {
  /** 在 Node 环境下能拿到真实 fs 路径的资源 */
  const load = (name: string) => loadPdfBuffer(name)

  it('resolvePdfAssets 在 Node 解析 pdfjs-dist 的 cmaps/standard_fonts', async () => {
    const a = await resolvePdfAssets()
    expect(a.cMapUrl).toMatch(/cmaps\/$/)
    expect(a.standardFontDataUrl).toMatch(/standard_fonts\/$/)
  })

  it('sample-cn.pdf：抽取中文 + 章节识别优先', async () => {
    const r = await importPdf(load('sample-cn.pdf'), '回退书名')
    expect(r.format).toBe('pdf')
    expect(r.title).toBe('回退书名') // 样本无 Title 元信息 → 用兜底
    expect(r.author).toBeUndefined()
    expect(r.warnings).toEqual([])

    // 三页正文都在
    expect(r.text).toContain('第一章')
    expect(r.text).toContain('第二章')
    expect(r.text).toContain('第三章')
    expect(r.text).toContain('山中旧信')
    expect(r.text).toContain('夜谈')

    // 章节识别（>=2）→ 用章节而非 "第 N 页"
    const titles = r.tocEntries?.map((e) => e.title) ?? []
    expect(titles.some((t) => t.includes('第一章'))).toBe(true)
    expect(titles.some((t) => t.includes('第二章'))).toBe(true)
    expect(titles.some((t) => t.includes('第三章'))).toBe(true)
    // 不应回退到 "第 N 页"
    expect(titles.some((t) => /^第 \d+ 页$/.test(t))).toBe(false)

    // 目录偏移应指向对应章节标题在正文中的位置
    for (const e of r.tocEntries ?? []) {
      if (e.title === '开篇') continue
      expect(r.text.slice(e.charIndex, e.charIndex + e.title.length)).toBe(e.title)
    }
  })

  it('sample-1page.pdf：1 页中文 CJK CMap 必须靠 cMapUrl 才能解出文字', async () => {
    // 该样本刻意只留 1 页 + 中文 Type0 字体（不带 ToUnicode），
    // 没有 cMapUrl 时 pdf.js 拿不出任何字符 —— 这条断言即回归保护。
    const r = await importPdf(load('sample-1page.pdf'), 'sample-1page')
    expect(r.format).toBe('pdf')
    expect(r.text).toContain('第一章')
    expect(r.text).toContain('山中旧信')
    // 1 页 → 章节识别能命中"第一章"，但仍 < 2 章门槛，回退到页码目录
    expect(r.tocEntries).toEqual([{ title: '第 1 页', charIndex: 0 }])
  })

  it('sample-encrypted.pdf：报"有密码保护"，且不报"已损坏"等其它原因', async () => {
    await expect(importPdf(load('sample-encrypted.pdf'), 'x')).rejects.toMatchObject({
      name: 'ImportError',
      message: expect.stringContaining('密码保护'),
    })
    // 不能误报为解析失败 / 扫描版
    await expect(importPdf(load('sample-encrypted.pdf'), 'x')).rejects.not.toThrow('损坏')
    await expect(importPdf(load('sample-encrypted.pdf'), 'x')).rejects.not.toThrow('扫描')
  })

  it('sample-scan-only.pdf：真实扫描版 → 走图片分支（不报错、不带文字、warnings 提示扫描版）', async () => {
    // 该 fixture 是从真实扫描版 PDF 抽出的 1 页，pdf.js 的 getTextContent 会返回空 items；
    // 在浏览器环境下应进入 V6.1 的扫描版回退分支（page.render → scannedPages）。
    // 但 Vitest 跑在 Node（没有 DOM canvas）， render 会走到 "无 canvas" 分支，
    // 最后等价于"扫描版且无法在位图模式下渲染"——提示用户走 OCR。
    // 这条断言同时证明：
    //   1) importPdf 确实把样本判成 scanned（不会先抛"PDF 解析失败"）
    //   2) 当 scannedPages 为空时按预期 throw "OCR 建议"，而不是把空内容吞掉
    await expect(importPdf(load('sample-scan-only.pdf'), 'x')).rejects.toMatchObject({
      name: 'ImportError',
      message: expect.stringContaining('没有可提取的文字'),
      hint: expect.stringContaining('OCR'),
    })
  })

  it('损坏的 PDF → 报 "PDF 解析失败" 且给"重新下载"建议', async () => {
    const garbage = new TextEncoder().encode('%PDF-1.7 this is not a real pdf')
    const err = await importPdf(garbage.buffer as ArrayBuffer, 'x').catch((e) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect(err.message).toContain('PDF 解析失败')
    expect(err.hint).toContain('重新下载')
  })
})
