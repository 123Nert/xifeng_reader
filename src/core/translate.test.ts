/**
 * translate.ts 单元测试：语言方向、按句切分、缓存与降级。
 *
 * 网络层通过注入的 fetchImpl 替身测试，不真的打外部接口
 * （真实接口另有浏览器实测，见 docs/V6.4-划词翻译方案.md §6）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearTranslateCache,
  detectDirection,
  isAmbiguousWord,
  isWordLookup,
  looksLikeNoise,
  wordGloss,
  looksChinese,
  MAX_SEGMENT_CHARS,
  splitForApi,
  splitWords,
  translateCacheSize,
  TranslateError,
  translateText,
  type TranslateFetch,
} from './translate'

beforeEach(() => clearTranslateCache())

describe('translate: 语言判断', () => {
  it('英文句子判为非中文', () => {
    expect(looksChinese('It is a truth universally acknowledged.')).toBe(false)
  })

  it('中文句子判为中文', () => {
    expect(looksChinese('这是一段中文，用来判断语言方向。')).toBe(true)
  })

  it('中英混排按多数决（README 式短句偏英文）', () => {
    expect(looksChinese('这是 README 文件')).toBe(true)
    expect(looksChinese('See the 文档 for details about translation')).toBe(false)
  })

  it('纯符号/数字不误判为中文', () => {
    expect(looksChinese('1234 ---- 5678')).toBe(false)
    expect(looksChinese('')).toBe(false)
  })
})

describe('translate: 方向判定', () => {
  it('auto：英文→中文，中文→英文', () => {
    expect(detectDirection('hello world', 'auto')).toBe('zh-CN')
    expect(detectDirection('你好世界', 'auto')).toBe('en')
  })

  it('用户固定目标时不再自动判断', () => {
    expect(detectDirection('hello world', 'en')).toBe('en')
    expect(detectDirection('你好世界', 'zh-CN')).toBe('zh-CN')
  })
})

describe('translate: 按句切分', () => {
  it('短文本原样返回一段', () => {
    expect(splitForApi('Hello world.')).toEqual(['Hello world.'])
  })

  it('超长文本在句末标点处断开，且每段不超上限', () => {
    const sentence = 'This is a sentence that is reasonably long for testing purposes. '
    const text = sentence.repeat(20).trim()
    const segs = splitForApi(text)
    expect(segs.length).toBeGreaterThan(1)
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
    // 拼回去内容不丢（空白归一）
    expect(segs.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '))
  })

  it('中文标点同样能断句', () => {
    const text = '这是一句话。'.repeat(80)
    const segs = splitForApi(text)
    expect(segs.length).toBeGreaterThan(1)
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
  })

  it('没有标点的超长串按空格退让，仍超长才硬切', () => {
    const noStop = 'word '.repeat(200).trim()
    const segs = splitForApi(noStop)
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
    const hard = 'x'.repeat(1000)
    const hardSegs = splitForApi(hard)
    expect(hardSegs.every((s) => s.length <= MAX_SEGMENT_CHARS)).toBe(true)
    expect(hardSegs.join('')).toBe(hard)
  })

  it('空文本切出空数组', () => {
    expect(splitForApi('   ')).toEqual([])
  })
})

describe('translate: 调用与缓存', () => {
  const fake = (out = '译文') => {
    const calls: Array<{ q: string; target: string }> = []
    const impl: TranslateFetch = async (q, target) => {
      calls.push({ q, target })
      return out
    }
    return { impl, calls }
  }

  it('英文句译为中文（auto）', async () => {
    const { impl, calls } = fake('真理')
    const r = await translateText('It is a truth.', { fetchImpl: impl })
    expect(r.target).toBe('zh-CN')
    expect(r.text).toBe('真理')
    expect(r.cached).toBe(false)
    expect(calls[0].q).toBe('It is a truth.')
    expect(calls[0].target).toBe('zh-CN')
  })

  it('中文句译为英文（auto）', async () => {
    const { impl, calls } = fake('Truth')
    const r = await translateText('这是一句中文。', { fetchImpl: impl })
    expect(r.target).toBe('en')
    expect(calls[0].target).toBe('en')
  })

  it('同一段文字第二次命中缓存，不再请求', async () => {
    const { impl, calls } = fake()
    await translateText('Same text.', { fetchImpl: impl })
    const second = await translateText('Same text.', { fetchImpl: impl })
    expect(second.cached).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('空白差异视为同一段（避免重复请求）', async () => {
    const { impl, calls } = fake()
    await translateText('Hello   world', { fetchImpl: impl })
    await translateText(' Hello world ', { fetchImpl: impl })
    expect(calls).toHaveLength(1)
  })

  it('长段落自动切分并拼回完整译文', async () => {
    const { impl, calls } = fake('片')
    const long = 'Sentence one is here. '.repeat(60)
    const r = await translateText(long, { fetchImpl: impl })
    expect(calls.length).toBeGreaterThan(1)
    expect(r.text).toBe('片'.repeat(calls.length))
  })

  it('接口失败时抛可读错误，且失败也被缓存（不反复打接口）', async () => {
    let n = 0
    const impl: TranslateFetch = async () => {
      n++
      throw new TranslateError('翻译服务连不上（可能没网）')
    }
    await expect(translateText('Fail text.', { fetchImpl: impl })).rejects.toThrow('连不上')
    await expect(translateText('Fail text.', { fetchImpl: impl })).rejects.toThrow('上次翻译失败')
    expect(n).toBe(1)
  })

  it('非 TranslateError 的异常被包装成可读文案', async () => {
    const impl: TranslateFetch = async () => {
      throw new TypeError('network down')
    }
    await expect(translateText('Boom.', { fetchImpl: impl })).rejects.toBeInstanceOf(TranslateError)
  })

  it('空文本直接报错，不发请求', async () => {
    const spy = vi.fn()
    await expect(translateText('   ', { fetchImpl: spy as unknown as TranslateFetch })).rejects.toThrow(
      '没有选中文字',
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it('缓存有上限，超限后整体清空（不无限增长）', async () => {
    const { impl } = fake()
    for (let i = 0; i < 401; i++) await translateText(`text ${i}`, { fetchImpl: impl })
    expect(translateCacheSize()).toBeLessThanOrEqual(1)
  })
})

describe('translate: 真实英文样本（Gutenberg 公版书）', () => {
  // test-fixtures/alice-en.txt：Alice's Adventures in Wonderland 正文（英文，约 14.8 万字符）
  const BLANK_LINE = /\n\s*\n/
  const alice = readFileSync(
    join(__dirname, '..', '..', 'test-fixtures', 'alice-en.txt'),
    'utf-8',
  )

  it('样本整体判为英文（不是中文）', () => {
    const head = alice.slice(0, 4000)
    expect(looksChinese(head)).toBe(false)
    expect(detectDirection(head, 'auto')).toBe('zh-CN')
  })

  it('取一个真实长段落，切分后每段都在 500 字符上限内', () => {
    const para = alice
      .split(BLANK_LINE)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .find((p) => p.length > 900)!
    expect(para).toBeTruthy()
    const segs = splitForApi(para)
    expect(segs.length).toBeGreaterThan(1)
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS)
  })

  it('开篇第一段能整段翻出中文（走注入的替身，验证链路）', async () => {
    const para = alice
      .split(BLANK_LINE)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .find((p) => p.startsWith('Alice was beginning'))!
    expect(para).toContain('sitting by her sister')
    const calls: string[] = []
    const r = await translateText(para, {
      fetchImpl: async (q) => {
        calls.push(q)
        return '译文'
      },
    })
    expect(r.target).toBe('zh-CN')
    expect(calls.join('')).toContain('Alice was beginning')
    expect(r.text.length).toBeGreaterThan(0)
  })
})

describe('translate: 单词语境补正', () => {
  it('识别 MyMemory 的"词源义"退化（beginning → 源）', () => {
    // 实测：单条译文常常是词源/构形义，读者要的是语境义
    expect(isAmbiguousWord('beginning')).toBe(true)
    expect(isAmbiguousWord('Running')).toBe(true)
    expect(isAmbiguousWord('rabbit')).toBe(false)
  })

  it('looksLikeNoise 认出"没翻"与"仍返回英文"', () => {
    expect(looksLikeNoise('hello', 'hello')).toBe(true)
    expect(looksLikeNoise('hello', '')).toBe(true)
    expect(looksLikeNoise('hello', 'hello world')).toBe(true) // 还是英文 → 退化
    expect(looksLikeNoise('hello', 'Hello there')).toBe(true)
    expect(looksLikeNoise('hello', '你好')).toBe(false)
    // 反向（中译英）时英文结果当然不算退化
    expect(looksLikeNoise('你好', 'hello', 'en')).toBe(false)
  })

  it('歧义词会追加一次整句翻译，并作为 context 返回', async () => {
    const qs: string[] = []
    const r = await translateText('beginning', {
      context: 'Alice was beginning to get very tired of sitting by her sister.',
      fetchImpl: async (q) => {
        qs.push(q)
        return q === 'beginning' ? '源' : '爱丽丝开始觉得很累了。'
      },
    })
    expect(r.text).toContain('开始') // 本地兜底义替换掉"源"
    expect(r.context).toBe('爱丽丝开始觉得很累了。')
    expect(qs).toHaveLength(2)
  })

  it('普通词不追加请求（一次就够）', async () => {
    const qs: string[] = []
    const r = await translateText('rabbit', {
      context: 'A White Rabbit with pink eyes ran close by her.',
      fetchImpl: async (q) => {
        qs.push(q)
        return '兔'
      },
    })
    expect(r.context).toBeUndefined()
    expect(qs).toHaveLength(1)
  })

  it('没有上下文时不追加（无从补正）', async () => {
    const qs: string[] = []
    await translateText('beginning', { fetchImpl: async (q) => { qs.push(q); return '源' } })
    expect(qs).toHaveLength(1)
  })

  it('整句补正失败不影响主译文', async () => {
    const r = await translateText('beginning', {
      context: 'Alice was beginning to get very tired.',
      fetchImpl: async (q) => {
        if (q.startsWith('Alice')) throw new Error('boom')
        return '源'
      },
    })
    expect(r.text).toContain('开始') // 兜底义仍在，整句补正失败也不影响
    expect(r.context).toBeUndefined()
  })
})

describe('translate: 单词兜底义（文学语境）', () => {
  it('动名词/分词给出本地义项（接口给的是词源义）', () => {
    expect(wordGloss('beginning')).toContain('开始')
    expect(wordGloss('Running')).toContain('跑')
    expect(wordGloss('reading')).toBeTruthy()
  })

  it('多义词给出与小说语境匹配的义项（bank → 岸）', () => {
    expect(wordGloss('bank')).toContain('岸')
  })

  it('普通词没有兜底义', () => {
    expect(wordGloss('rabbit')).toBeUndefined()
    expect(wordGloss('sister')).toBeUndefined()
  })

  it('歧义词用兜底义替换接口的词源义（beginning → 开始，而不是"源"）', async () => {
    const r = await translateText('beginning', {
      context: 'Alice was beginning to get very tired.',
      fetchImpl: async (q) => (q === 'beginning' ? '源' : '爱丽丝开始累了。'),
    })
    expect(r.text).toContain('开始')
    expect(r.gloss).toContain('开始')
    expect(r.context).toBe('爱丽丝开始累了。')
  })

  it('多义词保留接口结果，另附本地义项（bank → 银行 + 也作 岸）', async () => {
    const r = await translateText('bank', {
      context: 'Alice was sitting on the bank by her sister.',
      fetchImpl: async (q) => (q === 'bank' ? '银行' : '爱丽丝坐在她姐姐旁边的岸边。'),
    })
    expect(r.text).toBe('银行')
    expect(r.alt).toContain('岸')
    expect(r.context).toContain('岸边')
  })

  it('普通词不触发兜底（一次请求、无额外字段）', async () => {
    const qs: string[] = []
    const r = await translateText('rabbit', {
      context: 'A White Rabbit ran by.',
      fetchImpl: async (q) => { qs.push(q); return '兔' },
    })
    expect(r.gloss).toBeUndefined()
    expect(r.alt).toBeUndefined()
    expect(qs).toHaveLength(1)
  })
})

describe('translate: 选词辅助', () => {
  it('1~3 个词视为可查词', () => {
    expect(isWordLookup('fortune')).toBe(true)
    expect(isWordLookup('good fortune')).toBe(true)
    expect(isWordLookup('a single man')).toBe(true)
  })

  it('成句/过长/带句末标点不算查词', () => {
    expect(isWordLookup('This is a whole sentence.')).toBe(false)
    expect(isWordLookup('one two three four')).toBe(false)
    expect(isWordLookup('fortune.')).toBe(false)
  })

  it('splitWords 拆出候选词并丢掉单字符', () => {
    expect(splitWords('good fortune, a man')).toEqual(['good', 'fortune', 'man'])
  })
})
