/**
 * vocabulary.test.ts — 生词本纯函数单测（V6.6）。
 *
 * 覆盖：归一化、候选判定、记录组装、重复合并、Markdown 与 CSV 导出。
 */
import { describe, expect, it } from 'vitest'
import {
  buildVocabRecord,
  CONTEXT_MAX_CHARS,
  isVocabCandidate,
  isVocabDue,
  isVocabMastered,
  mergeVocabOnRecollection,
  normalizeVocabRecord,
  normalizeWord,
  retentionEstimate,
  reviewVocabRecord,
  vocabToCsv,
  vocabToMarkdown,
  type VocabRecord,
} from './vocabulary'

describe('vocabulary: 单词归一化', () => {
  it('转为小写并剥除首尾常见标点与引号壳', () => {
    expect(normalizeWord('"Hello"')).toBe('hello')
    expect(normalizeWord("'World'")).toBe('world')
    expect(normalizeWord('“Chapter”')).toBe('chapter')
    expect(normalizeWord('—beginning—')).toBe('beginning')
    expect(normalizeWord(' (Word)? ')).toBe('word')
  })

  it('保留词内合法的连字符与省字号', () => {
    expect(normalizeWord('state-of-the-art')).toBe('state-of-the-art')
    expect(normalizeWord("don't")).toBe("don't")
  })

  it('多词短语折叠内部连续空白', () => {
    expect(normalizeWord('  look   forward   to  ')).toBe('look forward to')
  })

  it('全是标点时归一化为空串', () => {
    expect(normalizeWord('...')).toBe('')
    expect(normalizeWord(' “”— ‘ ’ ')).toBe('')
  })
})

describe('vocabulary: 多出处兼容与复习排期', () => {
  const legacy: VocabRecord = {
    word: 'bank',
    bookId: 'b1',
    charIndex: 10,
    excerpt: 'river bank',
    gloss: '河岸',
    lookups: 1,
    createdAt: 100,
    lastLookupAt: 100,
  }

  it('旧记录归一化为单一出处并立即可复习', () => {
    const normalized = normalizeVocabRecord(legacy)
    expect(normalized.sources).toEqual([{ bookId: 'b1', charIndex: 10, excerpt: 'river bank', gloss: '河岸' }])
    expect(isVocabDue(normalized, 100)).toBe(true)
  })

  it('重收相同单词保留跨书出处，同一位置只留最新语境', () => {
    const first = mergeVocabOnRecollection(legacy, { ...legacy, createdAt: 200, lastLookupAt: 200 })
    const second = mergeVocabOnRecollection(first, { ...legacy, bookId: 'b2', charIndex: 50, excerpt: 'canal bank', createdAt: 300, lastLookupAt: 300 })
    const third = mergeVocabOnRecollection(second, { ...legacy, bookId: 'b1', charIndex: 10, excerpt: 'the bank', createdAt: 400, lastLookupAt: 400 })
    expect(third.sources).toHaveLength(2)
    expect(third.sources?.find((source) => source.bookId === 'b1')?.excerpt).toBe('the bank')
    expect(third.sources?.some((source) => source.bookId === 'b2')).toBe(true)
  })

  it('记住后按艾宾浩斯周期 1、2、4、7、15、30 天递进并毕业', () => {
    let record = normalizeVocabRecord(legacy)
    const intervals = [1, 2, 4, 7, 15, 30]
    let now = 1000
    for (let i = 0; i < intervals.length; i++) {
      record = reviewVocabRecord(record, true, now)
      expect(record.reviewStep).toBe(i + 1)
      expect(record.dueAt).toBe(now + intervals[i] * 86400000)
      now += 100
    }
    // 六次记住后毕业（走完 1/2/4/7/15/30 全部周期），退出待复习队列
    expect(record.reviewStep).toBe(6)
    expect(isVocabMastered(record)).toBe(true)
    expect(isVocabDue(record, now + 100 * 86400000)).toBe(false)
    // 毕业后再复习只走 90 天维护间隔
    record = reviewVocabRecord(record, true, now)
    expect(record.dueAt).toBe(now + 90 * 86400000)
  })

  it('忘了回退 2 级（不归零）并安排次日到期', () => {
    const record = reviewVocabRecord({ ...legacy, reviewStep: 3 }, false, 5000)
    expect(record.reviewStep).toBe(1)
    expect(record.dueAt).toBe(5000 + 86400000)
    expect(record.lastReviewedAt).toBe(5000)
    expect(isVocabDue(record, record.dueAt! - 1)).toBe(false)
    expect(isVocabDue(record, record.dueAt!)).toBe(true)
  })

  it('低级别遗忘退到 0 级（下限保护）', () => {
    const record = reviewVocabRecord({ ...legacy, reviewStep: 1 }, false, 5000)
    expect(record.reviewStep).toBe(0)
  })

  it('留存率按 e^(-t/S) 衰减，复习后回满', () => {
    // 第 0 级新词（S=1 天）：收藏 1 天后留存 ≈ 37%
    const fresh = { ...legacy, reviewStep: 0, lastReviewedAt: undefined } as VocabRecord
    const day1 = retentionEstimate(fresh, legacy.createdAt + 86400000)
    expect(day1).toBeGreaterThanOrEqual(36)
    expect(day1).toBeLessThanOrEqual(38)
    // 刚复习完留存回满 100%
    expect(retentionEstimate({ ...legacy, reviewStep: 0, lastReviewedAt: 1000 }, 1000)).toBe(100)
    // 高级别词衰减慢（S=30 天，10 天后 ≈ 72%）
    const senior = { ...legacy, reviewStep: 5, lastReviewedAt: 1000 }
    expect(retentionEstimate(senior, 1000 + 10 * 86400000)).toBeGreaterThanOrEqual(71)
    expect(retentionEstimate(senior, 1000 + 10 * 86400000)).toBeLessThanOrEqual(73)
    // 毕业词（S=90 天）几乎不衰减
    expect(retentionEstimate({ ...legacy, reviewStep: 6, lastReviewedAt: 1000 }, 1000 + 10 * 86400000)).toBeGreaterThanOrEqual(88)
  })
})

describe('vocabulary: 候选词判定', () => {
  it('1~3 个西文单词且无句末标点时为合法候选', () => {
    expect(isVocabCandidate('novel')).toBe(true)
    expect(isVocabCandidate('bank account')).toBe(true)
    expect(isVocabCandidate('in the air')).toBe(true)
  })

  it('带首尾标点的单词也是候选（因为归一化后非空）', () => {
    expect(isVocabCandidate('“wonder”')).toBe(true)
  })

  it('整句或超长文本拒绝进入生词本', () => {
    expect(isVocabCandidate('This is a complete sentence.')).toBe(false)
    expect(isVocabCandidate('a'.repeat(25))).toBe(false)
  })

  it('纯标点或空白拒绝', () => {
    expect(isVocabCandidate('')).toBe(false)
    expect(isVocabCandidate('   ')).toBe(false)
    expect(isVocabCandidate('???')).toBe(false)
  })
})

describe('vocabulary: 记录组装与重复合并', () => {
  const result = {
    text: '开始；开端',
    alt: '源',
    context: '这是一个崭新的开端。',
  }

  it('组装首条记录：初次收藏 lookups 为 1，时间戳自洽', () => {
    const rec = buildVocabRecord({
      source: ' “Beginning” ',
      bookId: 'b1',
      charIndex: 120,
      sentence: 'In the beginning was the Word.',
      result,
      now: 1000,
    })
    expect(rec.word).toBe('beginning')
    expect(rec.bookId).toBe('b1')
    expect(rec.charIndex).toBe(120)
    expect(rec.excerpt).toBe('In the beginning was the Word.')
    expect(rec.gloss).toBe('开始；开端')
    expect(rec.alt).toBe('源')
    expect(rec.context).toBe('这是一个崭新的开端。')
    expect(rec.lookups).toBe(1)
    expect(rec.createdAt).toBe(1000)
    expect(rec.lastLookupAt).toBe(1000)
  })

  it('语境超过上限时截断并加上省略号', () => {
    const longSentence = 'A'.repeat(CONTEXT_MAX_CHARS + 50)
    const rec = buildVocabRecord({
      source: 'word',
      bookId: 'b1',
      charIndex: 0,
      sentence: longSentence,
      result: { text: '词' },
    })
    expect(rec.excerpt.length).toBe(CONTEXT_MAX_CHARS)
    expect(rec.excerpt.endsWith('…')).toBe(true)
  })

  it('重复收藏：lookups 累加，保留首次收藏时间，更新最新语境与时间', () => {
    const first: VocabRecord = {
      word: 'bank',
      bookId: 'b1',
      charIndex: 50,
      excerpt: 'on the river bank',
      gloss: '岸',
      lookups: 1,
      createdAt: 1000,
      lastLookupAt: 1000,
    }
    const secondCandidate: VocabRecord = {
      word: 'bank',
      bookId: 'b2',
      charIndex: 888,
      excerpt: 'sat by the bank of a canal',
      gloss: '河岸',
      alt: '堤',
      lookups: 1,
      createdAt: 2000,
      lastLookupAt: 2000,
    }
    const merged = mergeVocabOnRecollection(first, secondCandidate)
    expect(merged.lookups).toBe(2)
    expect(merged.createdAt).toBe(1000)
    expect(merged.lastLookupAt).toBe(2000)
    expect(merged.bookId).toBe('b2')
    expect(merged.charIndex).toBe(888)
    expect(merged.excerpt).toBe('sat by the bank of a canal')
    expect(merged.gloss).toBe('河岸')
  })
})

describe('vocabulary: 导出 Markdown 与 CSV', () => {
  const records: VocabRecord[] = [
    {
      word: 'beginning',
      bookId: 'b1',
      charIndex: 10,
      excerpt: 'It was only the beginning.',
      gloss: '开始；开端',
      alt: '早先',
      context: '这仅仅是个开端。',
      lookups: 2,
      createdAt: 1000,
      lastLookupAt: 2000,
    },
    {
      word: 'quote, "test"',
      bookId: 'b1',
      charIndex: 20,
      excerpt: 'He said:\n"Hello, world!"',
      gloss: '带有逗号与"引号"的释义',
      lookups: 1,
      createdAt: 1500,
      lastLookupAt: 1500,
    },
  ]

  it('导出 Markdown 包含书名、词条、释义和例句', () => {
    const md = vocabToMarkdown(records, '爱丽丝梦游仙境', new Date(1700000000000))
    expect(md).toContain('# 《爱丽丝梦游仙境》生词本')
    expect(md).toContain('共 2 个生词')
    expect(md).toContain('## beginning')
    expect(md).toContain('> 开始；开端')
    expect(md).toContain('> 也作：早先')
    expect(md).toContain('> 整句：这仅仅是个开端。')
    expect(md).toContain('> 原句：It was only the beginning.')
  })

  it('导出 CSV 包含 UTF-8 BOM，且正确转义双引号和换行', () => {
    const csv = vocabToCsv(records)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('\uFEFFword,gloss,context')
    // 第一行正常词
    expect(lines[1]).toContain('"beginning"')
    expect(lines[1]).toContain('"开始；开端"')
    // 第二行含引号和换行，引号被加倍，换行被压成空格
    expect(lines[2]).toContain('""test""')
    expect(lines[2]).toContain('""引号""')
    expect(lines[2]).not.toContain('\n')
  })
})
