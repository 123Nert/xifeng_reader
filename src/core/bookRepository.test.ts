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
