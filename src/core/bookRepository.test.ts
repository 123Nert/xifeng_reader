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
