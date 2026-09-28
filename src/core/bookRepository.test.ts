/**
 * bookRepository.ts 单元测试（技术方案 §5）。
 * 基于 fake-indexeddb 覆盖：书籍增删查、进度读写、书库列表合并进度。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
// 整体安装 fake DOM IndexedDB（含 idb 依赖的 IDBRequest 等全局类）
import 'fake-indexeddb/auto'

let repo: typeof import('./bookRepository')

beforeEach(async () => {
  // 每个用例拿到全新的 indexedDB 与全新模块实例（仓储内部缓存了连接）
  vi.resetModules()
  globalThis.indexedDB = new IDBFactory()
  repo = await import('./bookRepository')
})

const book = (id: string, content: string, importedAt = 1000) => ({
  id,
  title: `书${id}`,
  content,
  size: content.length * 2,
  charset: 'utf-8',
  importedAt,
})

describe('bookRepository: 书籍', () => {
  it('入库后可取回正文，且正文字符数完整', async () => {
    const content = '第一段\n\n第二段'.repeat(100)
    await repo.addBook(book('b1', content))
    expect(await repo.getBookContent('b1')).toBe(content)
  })

  it('listLibrary 返回元信息与 charCount，不暴露正文字段', async () => {
    await repo.addBook(book('a', '内容甲', 1000))
    await repo.addBook(book('b', '内容乙很长很长'.repeat(10), 2000))

    const list = await repo.listLibrary()
    expect(list).toHaveLength(2)
    for (const e of list) {
      expect(e).not.toHaveProperty('content')
      expect(typeof e.charCount).toBe('number')
      expect(e.charCount).toBeGreaterThan(0)
    }
    // 没读过的按导入时间倒序
    expect(list[0].id).toBe('b')
    expect(list[1].id).toBe('a')
  })

  it('deleteBook 同时删除书籍与进度', async () => {
    await repo.addBook(book('gone', '正文'))
    await repo.saveProgress('gone', 2)

    await repo.deleteBook('gone')

    expect(await repo.getBookContent('gone')).toBeUndefined()
    expect(await repo.getProgress('gone')).toBeNull()
    expect(await repo.listLibrary()).toHaveLength(0)
  })
})

describe('bookRepository: 进度', () => {
  it('保存与读取进度往返一致', async () => {
    await repo.addBook(book('p1', '正文'))
    await repo.saveProgress('p1', 123)
    expect(await repo.getProgress('p1')).toBe(123)
  })

  it('重复保存覆盖旧值', async () => {
    await repo.addBook(book('p2', '正文'))
    await repo.saveProgress('p2', 10)
    await repo.saveProgress('p2', 50)
    expect(await repo.getProgress('p2')).toBe(50)
  })

  it('没有进度记录时返回 null', async () => {
    await repo.addBook(book('p3', '正文'))
    expect(await repo.getProgress('p3')).toBeNull()
  })

  it('listLibrary 合并进度：charIndex 与 lastReadAt 来自 progress store', async () => {
    await repo.addBook(book('read', '读过一些', 1000))
    await repo.addBook(book('fresh', '没读过', 2000))

    const before = Date.now() - 1
    await repo.saveProgress('read', 3)

    const list = await repo.listLibrary()
    const read = list.find((e) => e.id === 'read')!
    const fresh = list.find((e) => e.id === 'fresh')!

    expect(read.charIndex).toBe(3)
    expect(read.lastReadAt).toBeGreaterThanOrEqual(before)
    expect(fresh.charIndex).toBe(0)
    expect(fresh.lastReadAt).toBeNull()
    // 读过的排在没读过的前面
    expect(list[0].id).toBe('read')
  })
})

describe('bookRepository: 书签（V1.2）', () => {
  it('添加书签后按位置升序列出，且只含本书的书签', async () => {
    await repo.addBook(book('b1', '正文一'))
    await repo.addBook(book('b2', '正文二'))

    await repo.addBookmark('b1', 200, '第二页摘录')
    await repo.addBookmark('b1', 50, '第一页摘录')
    await repo.addBookmark('b2', 10, '另一本书')

    const list = await repo.listBookmarks('b1')
    expect(list.map((x) => x.charIndex)).toEqual([50, 200])
    expect(list[0].excerpt).toBe('第一页摘录')
    expect(list.every((x) => x.bookId === 'b1')).toBe(true)
  })

  it('删除书签后列表不再包含', async () => {
    await repo.addBook(book('b3', '正文'))
    const added = await repo.addBookmark('b3', 7, '摘录')
    await repo.deleteBookmark(added.id)
    expect(await repo.listBookmarks('b3')).toHaveLength(0)
  })

  it('重复位置的书签允许并存（书签不去重）', async () => {
    await repo.addBook(book('b4', '正文'))
    await repo.addBookmark('b4', 7, '甲')
    await repo.addBookmark('b4', 7, '乙')
    expect(await repo.listBookmarks('b4')).toHaveLength(2)
  })
})

describe('bookRepository: 阅读统计（V2.0）', () => {
  it('分钟数累加进当天，并汇总今日/本周/累计', async () => {
    await repo.addReadingMinutes(0.5)
    await repo.addReadingMinutes(0.5)
    await repo.addReadingMinutes(0)
    const stats = await repo.getReadingStats()
    expect(stats.todayMinutes).toBe(1)
    expect(stats.weekMinutes).toBe(1)
    expect(stats.totalMinutes).toBe(1)
  })

  it('非正数分钟忽略', async () => {
    await repo.addReadingMinutes(-1)
    const stats = await repo.getReadingStats()
    expect(stats.totalMinutes).toBe(0)
  })
})

describe('bookRepository: 重命名（V2.0）', () => {
  it('重命名后列表展示新书名', async () => {
    await repo.addBook(book('rn', '旧书名'))
    await repo.renameBook('rn', '  新书名 ')
    const list = await repo.listLibrary()
    expect(list[0].title).toBe('新书名')
  })

  it('空书名与不存在的书不产生变化', async () => {
    await repo.addBook(book('keep', '原名'))
    await repo.renameBook('keep', '   ')
    await repo.renameBook('ghost', '任意')
    expect((await repo.listLibrary())[0].title).toBe('书keep')
  })
})

describe('bookRepository: 封面（V6.3）', () => {
  it('写入封面后书库列表能读到', async () => {
    await repo.addBook(book('c1', '正文'))
    await repo.setBookCover('c1', 'data:image/jpeg;base64,AAA')
    const [entry] = await repo.listLibrary()
    expect(entry.cover).toBe('data:image/jpeg;base64,AAA')
  })

  it('传 null 清除封面（回退渐变色块）', async () => {
    await repo.addBook(book('c2', '正文'))
    await repo.setBookCover('c2', 'data:image/jpeg;base64,AAA')
    await repo.setBookCover('c2', null)
    expect((await repo.listLibrary())[0].cover).toBeUndefined()
  })

  it('不存在的书与其它字段都不受影响', async () => {
    await repo.addBookWithPdf(
      { ...book('c3', '正文'), format: 'pdf', pdfPageCount: 2 },
      { bytes: new Uint8Array([1, 2, 3]).buffer, size: 3 },
    )
    await repo.setBookCover('c3', 'data:image/jpeg;base64,BBB')
    await repo.setBookCover('ghost', 'data:image/jpeg;base64,CCC')

    const b = await repo.getBook('c3')
    expect(b?.cover).toBe('data:image/jpeg;base64,BBB')
    expect(b?.pdfPageCount).toBe(2)
    expect(b?.pdfOriginal).toBe(true)
    expect(b?.content).toBe('正文')
  })

  it('封面随备份导出并可恢复', async () => {
    await repo.addBook(book('c4', '正文'))
    await repo.setBookCover('c4', 'data:image/jpeg;base64,DDD')
    const backup = await repo.exportBackup({})

    vi.resetModules()
    globalThis.indexedDB = new IDBFactory()
    repo = await import('./bookRepository')
    await repo.importBackup(backup)
    expect((await repo.listLibrary())[0].cover).toBe('data:image/jpeg;base64,DDD')
  })
})

describe('bookRepository: 划线（V3.0）', () => {
  it('添加划线后按位置升序列出，仅含本书', async () => {
    await repo.addBook(book('h1', '正文'))
    await repo.addHighlight('h1', 100, 120, '第二段摘抄')
    await repo.addHighlight('h1', 10, 24, '第一段摘抄', { note: '写得真好' })
    await repo.addHighlight('other', 5, 9, '别的书')

    const list = await repo.listHighlights('h1')
    expect(list.map((x) => x.start)).toEqual([10, 100])
    expect(list[0].note).toBe('写得真好')
    expect(list.every((x) => x.bookId === 'h1')).toBe(true)
  })

  it('删除划线后列表不再包含', async () => {
    await repo.addBook(book('h2', '正文'))
    const added = await repo.addHighlight('h2', 3, 8, '摘录')
    await repo.deleteHighlight(added.id)
    expect(await repo.listHighlights('h2')).toHaveLength(0)
  })

  it('备份包含划线并可恢复', async () => {
    await repo.addBook(book('h3', '正文'))
    await repo.addHighlight('h3', 3, 8, '摘录')
    const backup = await repo.exportBackup({})
    expect(backup.highlights).toHaveLength(1)

    vi.resetModules()
    globalThis.indexedDB = new IDBFactory()
    repo = await import('./bookRepository')
    await repo.importBackup(backup)
    expect(await repo.listHighlights('h3')).toHaveLength(1)
  })
})

describe('bookRepository: 备份与恢复（V2.0）', () => {
  it('导出→清空→导入 后数据完好', async () => {
    await repo.addBook(book('bk', '正文体'))
    await repo.saveProgress('bk', 42)
    await repo.addBookmark('bk', 30, '摘录甲')
    await repo.addReadingMinutes(1.5)

    const backup = await repo.exportBackup({ fontSize: 20 })
    expect(backup.app).toBe('xifeng-reader')
    expect(backup.books).toHaveLength(1)
    expect(backup.settings).toEqual({ fontSize: 20 })

    // 模拟"清库后导入"：全新模块实例 + 全新数据库
    vi.resetModules()
    globalThis.indexedDB = new IDBFactory()
    repo = await import('./bookRepository')

    const report = await repo.importBackup(backup)
    expect(report.books).toBe(1)
    expect(await repo.getBookContent('bk')).toBe('正文体')
    expect(await repo.getProgress('bk')).toBe(42)
    expect(await repo.listBookmarks('bk')).toHaveLength(1)
    expect((await repo.getReadingStats()).totalMinutes).toBe(1.5)
  })

  it('非法备份文件抛出可读错误', async () => {
    await expect(repo.importBackup({ app: 'other' } as never)).rejects.toThrow(
      '不是有效的 xifeng 阅读备份文件',
    )
  })
})

// ---------- V6.2 PDF 原件 ----------

describe('bookRepository: PDF 原件（V6.2）', () => {
  const pdfBytes = () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]).buffer

  it('addBookWithPdf 存入原件并标记 pdfOriginal', async () => {
    const ok = await repo.addBookWithPdf(
      { ...book('p1', '正文'), format: 'pdf', pdfPageCount: 3, pdfPageStarts: [0, 10, 20] },
      { bytes: pdfBytes(), size: 7 },
    )
    expect(ok).toBe(true)
    const b = await repo.getBook('p1')
    expect(b?.pdfOriginal).toBe(true)
    expect(b?.pdfPageCount).toBe(3)
    expect(b?.pdfPageStarts).toEqual([0, 10, 20])
    // 原件字节往返一致
    const got = await repo.getPdfFile('p1')
    expect(got && new Uint8Array(got).length).toBe(7)
    expect(got && new Uint8Array(got)[0]).toBe(0x25)
  })

  it('不带原件时不标记 pdfOriginal，且清掉可能残留的旧原件', async () => {
    await repo.addBookWithPdf({ ...book('p2', '正文'), format: 'pdf' }, { bytes: pdfBytes(), size: 7 })
    expect(await repo.getPdfFile('p2')).toBeTruthy()

    const ok = await repo.addBookWithPdf({ ...book('p2', '正文'), format: 'pdf' }, null)
    expect(ok).toBe(false)
    expect((await repo.getBook('p2'))?.pdfOriginal).toBeUndefined()
    expect(await repo.getPdfFile('p2')).toBeUndefined()
  })

  it('deleteBook 一并清掉原件', async () => {
    await repo.addBookWithPdf({ ...book('p3', '正文'), format: 'pdf' }, { bytes: pdfBytes(), size: 7 })
    await repo.deleteBook('p3')
    expect(await repo.getPdfFile('p3')).toBeUndefined()
    expect(await repo.listLibrary()).toHaveLength(0)
  })

  it('listLibrary 带出 pdfOriginal / pdfPageCount', async () => {
    await repo.addBookWithPdf(
      { ...book('p4', '正文'), format: 'pdf', pdfPageCount: 9 },
      { bytes: pdfBytes(), size: 7 },
    )
    const [entry] = await repo.listLibrary()
    expect(entry.pdfOriginal).toBe(true)
    expect(entry.pdfPageCount).toBe(9)
    // 列表项不携带原始字节（避免把整本书的 PDF 拖进内存）
    expect(entry).not.toHaveProperty('bytes')
  })

  it('备份带上原件 base64，导入后可还原字节', async () => {
    await repo.addBookWithPdf({ ...book('p5', '正文'), format: 'pdf' }, { bytes: pdfBytes(), size: 7 })
    const backup = await repo.exportBackup({})
    expect(backup.pdfFiles).toHaveLength(1)
    expect(typeof backup.pdfFiles?.[0].bytes).toBe('string')

    vi.resetModules()
    globalThis.indexedDB = new IDBFactory()
    repo = await import('./bookRepository')
    const report = await repo.importBackup(backup)
    expect(report.pdfFiles).toBe(1)
    const bytes = await repo.getPdfFile('p5')
    expect(bytes && new Uint8Array(bytes)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]))
  })

  it('老备份（无 pdfFiles 字段）导入不报错', async () => {
    await repo.addBook(book('p6', '正文'))
    const backup = await repo.exportBackup({})
    delete backup.pdfFiles
    vi.resetModules()
    globalThis.indexedDB = new IDBFactory()
    repo = await import('./bookRepository')
    const report = await repo.importBackup(backup)
    expect(report.books).toBe(1)
    expect(report.pdfFiles).toBe(0)
  })

  it('原件 base64 损坏时跳过该条，不影响其余数据导入', async () => {
    await repo.addBook(book('p7', '正文'))
    const backup = await repo.exportBackup({})
    backup.pdfFiles = [{ bookId: 'p7', bytes: '!!!not-base64!!!', size: 3 }]
    vi.resetModules()
    globalThis.indexedDB = new IDBFactory()
    repo = await import('./bookRepository')
    const report = await repo.importBackup(backup)
    expect(report.books).toBe(1)
    expect(report.pdfFiles).toBe(0)
    expect(await repo.getPdfFile('p7')).toBeUndefined()
  })
})

// ---------- V6.6 生词本 ----------

describe('bookRepository: 生词本（V6.6）', () => {
  const sampleVocab = (word: string, bookId: string, lastLookupAt = 1000) => ({
    word,
    bookId,
    charIndex: 50,
    excerpt: `excerpt for ${word}`,
    gloss: `释义 ${word}`,
    lookups: 1,
    createdAt: 1000,
    lastLookupAt,
  })

  it('添加与查询生词，支持按书查询与时间倒序', async () => {
    await repo.addVocabRecord(sampleVocab('novel', 'b1', 1000))
    await repo.addVocabRecord(sampleVocab('author', 'b1', 2000))
    await repo.addVocabRecord(sampleVocab('other', 'b2', 1500))

    expect(await repo.getVocabRecord('novel')).toBeTruthy()
    expect(await repo.getVocabRecord('nonexistent')).toBeUndefined()

    const b1List = await repo.listVocabByBook('b1')
    expect(b1List).toHaveLength(2)
    // 最近查词的在前
    expect(b1List[0].word).toBe('author')
    expect(b1List[1].word).toBe('novel')

    const all = await repo.listVocabAll()
    expect(all).toHaveLength(3)
    expect(all[0].word).toBe('author')
  })

  it('同词覆盖更新', async () => {
    await repo.addVocabRecord(sampleVocab('bank', 'b1', 1000))
    const updated = {
      ...sampleVocab('bank', 'b2', 3000),
      gloss: '河岸；堤',
      lookups: 2,
    }
    await repo.addVocabRecord(updated)

    const got = await repo.getVocabRecord('bank')
    expect(got?.lookups).toBe(2)
    expect(got?.bookId).toBe('b2')
    expect(got?.gloss).toBe('河岸；堤')
  })

  it('deleteVocabRecord 单条删除', async () => {
    await repo.addVocabRecord(sampleVocab('del', 'b1'))
    await repo.deleteVocabRecord('del')
    expect(await repo.getVocabRecord('del')).toBeUndefined()
  })

  it('deleteBook 级联清除该书关联的生词', async () => {
    await repo.addBook(book('del-book', '正文'))
    await repo.addVocabRecord(sampleVocab('w1', 'del-book'))
    await repo.addVocabRecord(sampleVocab('w2', 'del-book'))
    await repo.addVocabRecord(sampleVocab('w3', 'other-book'))

    await repo.deleteBook('del-book')

    expect(await repo.listVocabByBook('del-book')).toHaveLength(0)
    expect(await repo.getVocabRecord('w1')).toBeUndefined()
    expect(await repo.getVocabRecord('w2')).toBeUndefined()
    // 其它书的生词依然保留
    expect(await repo.getVocabRecord('w3')).toBeTruthy()
  })

  it('备份导出与导入还原生词本（含老备份兼容）', async () => {
    await repo.addBook(book('bk-v', '正文'))
    await repo.addVocabRecord(sampleVocab('vocab1', 'bk-v'))

    const backup = await repo.exportBackup(null)
    expect(backup.vocab).toHaveLength(1)
    expect(backup.vocab?.[0].word).toBe('vocab1')

    // 清库后导入
    vi.resetModules()
    globalThis.indexedDB = new IDBFactory()
    repo = await import('./bookRepository')

    const report = await repo.importBackup(backup)
    expect(report.vocab).toBe(1)
    expect(await repo.getVocabRecord('vocab1')).toBeTruthy()

    // 测试老备份（无 vocab 字段）兼容性
    delete backup.vocab
    const reportOld = await repo.importBackup(backup)
    expect(reportOld.vocab).toBe(0)
  })
})
