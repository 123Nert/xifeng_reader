/**
 * purify.ts — TXT 净化（V1.3，纯函数）。
 *
 * 网文 TXT 常混入推广行（"笔趣阁 www.xxx.com"、"求月票"等）。
 * 策略：只删除"短行 + 命中推广特征"的行——长正文行永远不会被误删。
 *
 * 架构说明：计划文档原设想"展示时应用"，但净化会改变文本长度，
 * 与 PageMap 的字符偏移坐标系冲突；故改为**导入时应用**并入库净化后
 * 的正文，原始文件始终保留在用户手中。
 */

export interface PurifyReport {
  text: string
  /** 被删除的行数 */
  removed: number
}

/** 推广/水印行特征（对整行做测试）。 */
const JUNK_PATTERNS: RegExp[] = [
  /(https?:\/\/|www\.)/i,
  /[\w-]+\.(?:com|cn|net|cc|org|info|top|vip|site|xyz)(?:[^\u4e00-\u9fff]|$)/i,
  /笔趣阁|字节文学|天才一秒|一秒记住|最快更新|最新章节|本书来自|本站网址|请记住本书|首发于|转载请注明|求收藏|求推荐票?|求月票|求订阅|章节错误|点此举报|无弹窗|广告净/
]

/** 行长度上限：超过此长度的行视为正文，即便命中关键词也不删。 */
const SAFE_LINE_LENGTH = 80

/** 单行是否为推广/水印行。 */
function isJunkLine(line: string): boolean {
  const t = line.trim()
  if (!t || t.length > SAFE_LINE_LENGTH) return false
  return JUNK_PATTERNS.some((p) => p.test(t))
}

/**
 * 净化文本：移除推广行，其余内容（含空行结构）原样保留。
 */
export function purifyText(text: string): PurifyReport {
  if (!text) return { text, removed: 0 }
  const lines = text.split(/\r?\n/)
  const kept = lines.filter((line) => {
    if (isJunkLine(line)) return false
    return true
  })
  const removed = lines.length - kept.length
  if (removed === 0) return { text, removed: 0 }
  return { text: kept.join('\n'), removed }
}
