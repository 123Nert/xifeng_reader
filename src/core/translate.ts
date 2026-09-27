/**
 * translate.ts — 划词翻译（V6.4，纯逻辑 + 薄网络层）。
 *
 * 阅读本体是纯本地的；翻译是本项目第一个需要联网的功能，因此刻意做成：
 * - **只发选中的那一段**（不整本上传），发什么由用户划什么决定；
 * - **失败可降级**：接口挂了只影响这一次翻译，阅读/批注/续读全不受影响；
 * - **纯函数在前**：语言判断、按句切分、缓存都可以单测，网络调用只是最后一层。
 *
 * 接口选型（见 docs/V6.4-划词翻译方案.md §2）：
 * Google 非官方接口实测被 429 限流、LibreTranslate 公共实例 403/502/证书过期，
 * 只有 MyMemory 可用：返回中文、CORS 放开、匿名单次上限 500 字符。
 * 所以这里按句切分到 450 字符以内再并发请求，然后拼回整段译文。
 */

/** 翻译方向的目标语言。`auto` 表示按选中文本判断。 */
export const TRANSLATE_TARGETS = ['auto', 'zh-CN', 'en'] as const
export type TranslateTarget = (typeof TRANSLATE_TARGETS)[number]
export const TRANSLATE_TARGET_LABELS: Record<TranslateTarget, string> = {
  auto: '自动（英文→中文 / 中文→英文）',
  'zh-CN': '中文',
  en: 'English',
}

/** MyMemory 匿名单次上限 500 字符，留出余量给 URL 编码。 */
export const MAX_SEGMENT_CHARS = 450

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/
const LATIN_RE = /[A-Za-z]/

/** 文本的"语言倾向"：CJK 字符占比 > 0.3 → 中文，否则按西文处理。 */
export function looksChinese(text: string): boolean {
  let cjk = 0
  let latin = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++
    else if (LATIN_RE.test(ch)) latin++
  }
  const total = cjk + latin
  if (total === 0) return false
  return cjk / total > 0.3
}

/**
 * 由选中文本与用户设置决定目标语言（纯函数）。
 * 读英文书时用户不必每次改设置 —— `auto` 就是为此存在。
 */
export function detectDirection(text: string, target: TranslateTarget = 'auto'): 'zh-CN' | 'en' {
  if (target !== 'auto') return target
  return looksChinese(text) ? 'en' : 'zh-CN'
}

/**
 * 把长文本切成 <= maxChars 的多段，**尽量在句子边界切**（避免把一句话截成两半）。
 * 单句就超长时按空格退让，仍超长才硬切。
 */
export function splitForApi(text: string, maxChars: number = MAX_SEGMENT_CHARS): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.length <= maxChars) return [trimmed]

  // 在句末标点后断开（中英文标点都认），保留标点
  const sentences = trimmed.match(/[^.!?。！？；;\n]+[.!?。！？；;\n]*/g) ?? [trimmed]
  const out: string[] = []
  let cur = ''

  const flush = () => {
    if (cur.trim()) out.push(cur.trim())
    cur = ''
  }

  for (const s of sentences) {
    if (s.length > maxChars) {
      // 单句超长（少见：无标点的长串）→ 按空格断，仍超长则硬切
      flush()
      let rest = s
      while (rest.length > maxChars) {
        const cut = rest.lastIndexOf(' ', maxChars)
        const at = cut > maxChars * 0.5 ? cut : maxChars
        out.push(rest.slice(0, at).trim())
        rest = rest.slice(at)
      }
      cur = rest
      continue
    }
    if (cur.length + s.length > maxChars) flush()
    cur += s
  }
  flush()
  return out
}

export interface TranslationResult {
  /** 译文 */
  text: string
  /** 实际使用的目标语言 */
  target: 'zh-CN' | 'en'
  /** 原文（与传入一致，便于浮卡展示） */
  source: string
  /** 是否命中缓存 */
  cached: boolean
  /** 结果是否来自「原样返回」（接口拒绝翻译等），UI 可提示 */
  degraded?: boolean
  /** 单词退化时补的一次"所在整句"译文（语境对照用，可选） */
  context?: string
  /** 单词的本地兜底义（接口给的是词源义时用它，可选） */
  gloss?: string
  /** 另一个常见义项（多义词时与主译文并列展示，可选） */
  alt?: string
}

export class TranslateError extends Error {
  constructor(
    message: string,
    /** 面向用户的一句话建议 */
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'TranslateError'
  }
}

/** 一次网络请求的函数签名：便于测试注入，也便于以后换成自建服务。 */
export type TranslateFetch = (q: string, target: 'zh-CN' | 'en') => Promise<string>

const ENDPOINT = 'https://api.mymemory.translated.net/get'

/** MyMemory 超限/出错时会返回 200 + 这句英文，需要当失败处理。 */
const API_ERROR_MARKERS = ['QUERY LENGTH LIMIT', 'INVALID', 'MYMEMORY WARNING', 'NO QUERY SPECIFIED']

/**
 * 默认实现：MyMemory 免费接口（CORS 放开，无需 key）。
 * 注意它把错误也放在 200 里，所以必须检查正文内容而不只是状态码。
 */
export const myMemoryFetch: TranslateFetch = async (q, target) => {
  const url = `${ENDPOINT}?q=${encodeURIComponent(q)}&langpair=${target === 'en' ? 'zh-CN|en' : 'en|zh-CN'}`
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    throw new TranslateError('翻译服务连不上（可能没网）', '检查网络后重试；其余功能不受影响')
  }
  if (!res.ok) {
    throw new TranslateError(`翻译服务返回 ${res.status}`, '免费接口有频率限制，稍后再试')
  }
  const data = (await res.json().catch(() => null)) as
    | { responseData?: { translatedText?: unknown }; responseStatus?: unknown }
    | null
  const text = data?.responseData?.translatedText
  if (typeof text !== 'string' || !text.trim()) {
    throw new TranslateError('翻译服务没有返回结果', '稍后重试，或换一段文字试试')
  }
  const upper = text.toUpperCase()
  if (API_ERROR_MARKERS.some((m) => upper.includes(m))) {
    throw new TranslateError('翻译服务暂时不可用（额度或频率限制）', '过一会儿再试')
  }
  return decodeEntities(text)
}

/** 接口偶尔回实体（&quot; 之类），浏览器里交给 textarea 解一次。 */
function decodeEntities(s: string): string {
  if (!/[&<]/.test(s)) return s
  if (typeof document === 'undefined') return s
  const el = document.createElement('textarea')
  el.innerHTML = s
  return el.value
}

/** 内存缓存：同一段文字（含失败）不再重复请求。 */
const cache = new Map<string, TranslationResult>()
const failed = new Set<string>()
/** 上限保护：长文逐段翻译时条目会变多，超出就整体清空（用不着精细 LRU）。 */
const CACHE_LIMIT = 400

export function clearTranslateCache(): void {
  cache.clear()
  failed.clear()
}

export function translateCacheSize(): number {
  return cache.size
}

/**
 * 翻译一段文字。
 *
 * 单词语境补正（V6.4 实测）：MyMemory 对孤立单词常给"词源/构形"套话
 * （beginning → "源"），此时再补一次**带上下文的翻译**（把整句一起发过去、
 * 再取词的位置）不划算，退一步给出"该词所在短语"的译文更有用。
 * 这里只在明显退化（`looksLikeNoise` 或命中 `AMBIGUOUS_WORDS`）时
 * 追加一次上下文请求，正常词一次就够。
 *
 * @param text 选中的原文
 * @param opts.target 目标语言（默认 auto：英文→中文、中文→英文）
 * @param opts.context 选中文字所在的整句（有则用于单词语境补正）
 * @param opts.fetchImpl 注入的网络实现（单测用；默认 MyMemory）
 */
export async function translateText(
  text: string,
  opts: {
    target?: TranslateTarget
    context?: string
    fetchImpl?: TranslateFetch
    signal?: AbortSignal
  } = {},
): Promise<TranslationResult> {
  const source = text.replace(/\s+/g, ' ').trim()
  if (!source) throw new TranslateError('没有选中文字')

  const target = detectDirection(source, opts.target ?? 'auto')
  const key = `${target}::${source}`
  const hit = cache.get(key)
  if (hit) return { ...hit, cached: true }
  if (failed.has(key)) {
    throw new TranslateError('这段文字上次翻译失败', '稍后再试，或换一段试试')
  }

  const doFetch = opts.fetchImpl ?? myMemoryFetch
  const segments = splitForApi(source)
  try {
    const parts: string[] = []
    for (const seg of segments) {
      if (opts.signal?.aborted) throw new TranslateError('已取消')
      parts.push(await doFetch(seg, target))
    }

    // 单词退化时：本地兜底义 + 一次"所在整句"翻译（语境对照）
    const context = opts.context?.replace(/\s+/g, ' ').trim()
    const rawText = parts.join('')
    const ambiguous = target === 'zh-CN' && isAmbiguousWord(source)
    const degraded = target === 'zh-CN' && (looksLikeNoise(source, rawText, target) || ambiguous)
    const gloss = target === 'zh-CN' ? wordGloss(source) : undefined

    // 本地兜底义的使用分寸：动名词/分词（beginning、running）接口几乎必定给词源义，
    // 直接替换；其它多义词（bank、wonder）保留接口结果，另有义项时附在 `alt` 里并列展示。
    const replaceWithGloss = !!(gloss && (ambiguous || looksLikeNoise(source, rawText, target)))
    const text = replaceWithGloss ? gloss! : rawText
    const alt = !replaceWithGloss && gloss && gloss !== rawText ? gloss : undefined

    // 只要"这个词可能译得不对"（接口结果退化、或本地另有义项），就补一次整句翻译：
    // 单词的准确含义靠句子定，读者看到整句才能判断该取哪个义项。
    let contextLine: string | undefined
    if ((degraded || alt) && context && context.length > source.length && context.length <= MAX_SEGMENT_CHARS) {
      try {
        const ctxText = await doFetch(context, target)
        // 整句译文若本身也退化了就不要（宁可只给单词的译文）
        if (ctxText && !looksLikeNoise(context, ctxText, target)) contextLine = ctxText
      } catch {
        /* 补正失败不影响主结果 */
      }
    }

    const result: TranslationResult = {
      text,
      target,
      source,
      cached: false,
      ...(replaceWithGloss ? { degraded: true, gloss } : {}),
      ...(alt ? { alt } : {}),
      ...(contextLine ? { context: contextLine } : {}),
    }
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(key, result)
    return result
  } catch (e) {
    // 失败也记一笔：同一段文字反复点「译」不该反复打接口
    failed.add(key)
    if (e instanceof TranslateError) throw e
    throw new TranslateError('翻译失败', e instanceof Error ? e.message : '稍后重试')
  }
}

/**
 * 单词语义上的"翻译陷阱"：MyMemory 对这些常见词会返回**词源/构形套话**
 * （实测 beginning → "源"、running → "运行"、reading → "阅读"），
 * 读者要的是"在这句语境里的意思"。
 */
export const AMBIGUOUS_WORDS = new Set([
  'beginning', 'beginnings', 'running', 'reading', 'writing', 'meeting', 'building',
  'feeling', 'looking', 'coming', 'going', 'having', 'being', 'doing', 'seeing',
  'working', 'talking', 'thinking', 'standing', 'sitting', 'waiting', 'playing',
])

/**
 * 单次翻译的可读性启发：把"看起来不像译文"的结果判为退化。
 * 纯函数，便于单测；用于决定是否补一次上下文翻译。
 *
 * 判据（面向"英译中"这条主路径）：
 * - 空结果；
 * - 译文与原文一模一样（接口把原文退回来了）；
 * - 目标语言是中文，结果里却一个汉字都没有（说明还停在英文）。
 */
export function looksLikeNoise(
  source: string,
  translation: string,
  target: 'zh-CN' | 'en' = 'zh-CN',
): boolean {
  const t = translation.trim()
  if (!t) return true
  if (t.toLowerCase() === source.trim().toLowerCase()) return true
  if (target === 'zh-CN' && !/[\u4e00-\u9fff]/.test(t) && /[A-Za-z]/.test(t)) return true
  return false
}

/**
 * 单词的"兜底义"：接口对孤立单词常给词源/构形义（实测 beginning → "源"、
 * running → "运行"、bank → "银行"），在英文小说里基本都是错的。
 * 这些词单靠机器翻译没有稳定答案，所以由本地表给出**文学语境里最常见的中文义**，
 * 同时保留整句译文做语境对照 —— 精确的语感交给读者看整句判断。
 */
export const WORD_GLOSSES: Record<string, string> = {
  beginning: '开始；开端',
  beginnings: '开端；早期',
  running: '跑；奔跑',
  reading: '阅读；读书',
  writing: '写作；书写',
  meeting: '相遇；会面',
  building: '建筑物；建造',
  feeling: '感觉；感受',
  looking: '看；注视',
  coming: '来；到来',
  going: '去；离开',
  having: '拥有；有',
  being: '存在；是',
  doing: '做；行动',
  seeing: '看见；理解',
  working: '工作；运转',
  talking: '说话；交谈',
  thinking: '思考；想法',
  standing: '站立；站着',
  sitting: '坐；坐着',
  waiting: '等待；等候',
  playing: '玩耍；演奏',
  wonder: '惊奇；奇观（此处多指"奇境"）',
  bank: '岸；堤（此处非"银行"）',
}

/** 该词是否有本地兜底义。 */
export function wordGloss(text: string): string | undefined {
  const w = text.trim().toLowerCase().replace(/[^a-z]/g, '')
  return WORD_GLOSSES[w]
}

/** 选中的是不是"能当词条翻"的短词（1~3 个词）。 */
export function isWordLookup(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 24) return false
  return t.split(/\s+/).length <= 3 && !/[.!?。！？]/.test(t)
}

/** 短词是否属于"单独翻不可靠"的那类（动名词/多义词）。 */
export function isAmbiguousWord(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[^a-z]/g, '')
  return AMBIGUOUS_WORDS.has(t)
}

/**
 * 逐词翻译（选词时额外给出）。短词场景接口给的就是词义，
 * 这里只负责把多个词并列拆开 —— 不假装提供词性/音标（MyMemory 没有）。
 */
export function splitWords(text: string): string[] {
  return text
    .split(/[^A-Za-z\u4e00-\u9fff'’-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1)
    .slice(0, 4)
}
