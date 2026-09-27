/**
 * cover.ts — 书架封面生成（V6.3）。
 *
 * 书架上每本书都要"一眼认得出"，所以封面 = 这本书打开后的第一页：
 * - PDF：复用 pdfFiles 原件，按封面尺寸渲染第 1 页（见 pdfOriginal.renderPdfFirstPage）；
 * - TXT / MD / HTML：正文开头按"纸页"样式画出来（本模块）；
 * - EPUB：书里自带封面图优先，没有则退回正文第一页。
 *
 * 纯函数在前（摘录 / 折行 / 版面参数，可单测），canvas 绘制只是薄薄一层。
 * 封面尺寸固定 400×560（5:7，与 .book-cover 的 aspect-ratio 一致），
 * 卡片上显示约 158px 宽，2.5 倍余量足够清晰。
 */

/** 封面位图尺寸（5:7，与 .book-cover 宽高比一致）。 */
export const COVER_WIDTH = 400
export const COVER_HEIGHT = 560

/** 版心（四周留白）与排版参数：按封面宽度等比推导，改尺寸不用改公式。 */
export interface CoverLayout {
  padding: number
  fontSize: number
  lineHeight: number
  /** 每行最多几个全角字符 */
  charsPerLine: number
  /** 最多画几行 */
  maxLines: number
}

export function coverLayout(width: number = COVER_WIDTH): CoverLayout {
  const padding = Math.round(width * 0.09)
  const fontSize = Math.max(10, Math.round(width * 0.045))
  const lineHeight = fontSize * 1.7
  const contentWidth = width - padding * 2
  const contentHeight = Math.round((width * COVER_HEIGHT) / COVER_WIDTH) - padding * 2
  return {
    padding,
    fontSize,
    lineHeight,
    charsPerLine: Math.max(1, Math.floor(contentWidth / fontSize)),
    maxLines: Math.max(1, Math.floor(contentHeight / lineHeight)),
  }
}

/** 半角字符按 0.55 个全角宽度计（与多数中文字体的实际比例接近）。 */
function charWidth(ch: string): number {
  return /[\u0000-\u00ff]/.test(ch) ? 0.55 : 1
}

export interface WrappedText {
  lines: string[]
  /** 是否因为超出 maxLines 而丢掉了后续文字 */
  truncated: boolean
}

/**
 * 按"每行 N 个全角字符"折行。中文没有空格可依，只能按字宽累积；
 * 行首不留空格，行尾空白剪掉。超出行数上限时 `truncated` 为 true。
 */
export function wrapByWidth(text: string, charsPerLine: number, maxLines: number): WrappedText {
  const lines: string[] = []
  let cur = ''
  let curWidth = 0
  let truncated = false

  const pushLine = () => {
    if (cur) lines.push(cur.trimEnd())
    cur = ''
    curWidth = 0
  }

  for (const ch of text.replace(/\s+/g, ' ')) {
    if (ch === ' ') {
      if (curWidth === 0) continue // 行首不留空格
      if (curWidth + charWidth(ch) <= charsPerLine) {
        cur += ch
        curWidth += charWidth(ch)
      }
      continue
    }
    const w = charWidth(ch)
    if (curWidth + w > charsPerLine && cur) {
      pushLine()
      if (lines.length >= maxLines) {
        truncated = true
        break
      }
    }
    cur += ch
    curWidth += w
  }

  if (!truncated) {
    pushLine()
    if (lines.length > maxLines) {
      lines.length = maxLines
      truncated = true
    }
  } else {
    lines.length = Math.min(lines.length, maxLines)
  }

  return { lines, truncated }
}

export interface CoverExcerpt {
  /** 标题行（书里的首行短句，没有则为 null） */
  title: string | null
  /** 正文行 */
  lines: string[]
  /** 是否因为放不下而截断（末行会加省略号） */
  truncated: boolean
}

/** 首行短、后面还有正文 → 视为标题（与阅读页排版习惯一致：标题常单独成行）。 */
function pickTitle(paragraphs: string[]): { title: string | null; bodyStart: number } {
  const first = paragraphs[0]
  if (!first) return { title: null, bodyStart: 0 }
  // 开头就是章节标题行（"第1回 风雪夜行"）：它本身就是最好的封面标题
  if (looksLikeHeading(first)) return { title: first, bodyStart: 1 }

  const restLen = paragraphs.slice(1).join('').length
  if (first.length <= 24 && restLen >= 40) return { title: first, bodyStart: 1 }
  return { title: null, bodyStart: 0 }
}

/**
 * 取封面正文：从标题之后开始，**跳过开头的章节标题行**，取到下一行又是标题为止。
 *
 * 封面是"一眼认出这是哪本书"，不是目录 —— 正文若以连着几行章节标题开头
 * （"第1回/第2回/第3回…"），把标题全画上去只会让封面变成目录页；
 * 反之正文本身也要取到内容（不能只取到标题就空着）。
 */
function takeBodyLines(paragraphs: string[], bodyStart: number): string[] {
  const out: string[] = []
  for (let i = bodyStart; i < paragraphs.length; i++) {
    const p = paragraphs[i]
    if (looksLikeHeading(p)) {
      if (out.length > 0) break // 已进入正文，遇到下一章标题就收尾
      continue // 正文前的章节标题一律跳过
    }
    out.push(p)
    if (out.join('').length >= 400) break
  }
  return out
}

/**
 * 正文 → 封面要画的摘录（纯函数）。
 * @param text 书籍正文
 * @param layout 版面参数（默认 400×560 的版心）
 */
export function coverExcerpt(text: string, layout: CoverLayout = coverLayout()): CoverExcerpt {
  const paragraphs = collapseRepeats(
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  )

  const { title, bodyStart } = pickTitle(paragraphs)
  const rest = takeBodyLines(paragraphs, bodyStart)
  // 标题占 1~2 行，另留一行空档
  const titleLines = title ? Math.min(2, Math.max(1, Math.ceil(title.length / layout.charsPerLine))) : 0
  const bodyBudget = Math.max(1, layout.maxLines - titleLines - (title ? 1 : 0))

  const lines: string[] = []
  let truncated = false
  for (const para of rest) {
    if (lines.length >= bodyBudget) {
      truncated = true
      break
    }
    const wrapped = wrapByWidth(para, layout.charsPerLine, bodyBudget - lines.length)
    lines.push(...wrapped.lines)
    if (wrapped.truncated) {
      truncated = true
      break
    }
  }

  return { title, lines: lines.slice(0, bodyBudget), truncated }
}

/**
 * 折叠转换产物里的**紧挨着**的重复段落。
 *
 * 网文 TXT 常见残留：分页把跨页内容又贴了一次，同一段紧跟着排两遍。
 * 封面只有一屏，这种重复会白白占掉半行版面 —— 展示层面折叠掉。
 */
function collapseRepeats(paragraphs: string[]): string[] {
  const out: string[] = []
  for (const p of paragraphs) {
    if (out.length > 0 && out[out.length - 1] === p) continue
    out.push(p)
  }
  return out
}

/**
 * 是否是章节标题行（与 toc.ts 的内置模式同源，这里只用于"封面到第一章正文为止"）。
 * 保守起见只认最典型的几种，避免把普通短行当标题。
 */
const HEADING_RE = [
  /^第\s*[〇○零一二三四五六七八九十百千万两0-9]{1,7}\s*[章节回卷部集篇](?:\s[^\n]{0,40})?$/,
  /^卷\s*[〇○零一二三四五六七八九十百千万两0-9]{1,7}(?:\s[^\n]{0,40})?$/,
  /^[Cc]hapter\s+[0-9IVXivx]{1,7}(?:\s[^\n]{0,40})?$/,
  /^(?:序章|楔子|引子|序言|前言|尾声|后记|终章)(?:\s[^\n]{0,30})?$/,
]

function looksLikeHeading(line: string): boolean {
  const t = line.trim()
  if (!t || t.length > 60) return false
  return HEADING_RE.some((re) => re.test(t))
}

// ---------- canvas 绘制（薄层；Node 里没有 canvas 时返回 null） ----------

/** 纸页底色：与阅读页日间主题同色系（米白纸 + 极淡描边）。 */
const PAPER = '#fdfbf5'
const INK = '#2c2a26'
const HAIRLINE = 'rgba(0, 0, 0, 0.08)'

/** 与阅读页一致的正文衬线栈（封面用同一套字体，看上去才是"同一本书"）。 */
const COVER_FONT = "Georgia, 'Songti SC', 'Noto Serif CJK SC', 'SimSun', serif"

function canDraw(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function'
}

/**
 * 把正文摘录画成封面 dataURL（JPEG 质量 0.9）。
 * 无 DOM canvas 的环境（单测/Node）返回 null —— 封面是可选增强，不能挡住导入。
 */
export function drawTextCover(text: string, width = COVER_WIDTH): string | null {
  if (!canDraw()) return null
  const layout = coverLayout(width)
  const { title, lines, truncated } = coverExcerpt(text, layout)
  if (!title && lines.length === 0) return null

  const height = Math.round((width * COVER_HEIGHT) / COVER_WIDTH)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = HAIRLINE
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1)

  ctx.fillStyle = INK
  ctx.textBaseline = 'top'
  let y = layout.padding

  if (title) {
    const titleSize = Math.round(layout.fontSize * 1.25)
    ctx.font = `600 ${titleSize}px ${COVER_FONT}`
    const titleLines = wrapByWidth(
      title,
      Math.max(1, Math.floor((width - layout.padding * 2) / titleSize)),
      2,
    ).lines
    for (const line of titleLines) {
      ctx.fillText(line, layout.padding, y)
      y += titleSize * 1.5
    }
    y += layout.fontSize * 0.6
  }

  ctx.font = `${layout.fontSize}px ${COVER_FONT}`
  lines.forEach((line, i) => {
    const isLast = i === lines.length - 1
    ctx.fillText(isLast && truncated ? line.replace(/.$/, '') + '…' : line, layout.padding, y)
    y += layout.lineHeight
  })

  return canvas.toDataURL('image/jpeg', 0.9)
}

/**
 * 把一张（PDF/EPUB 的）位图缩到封面尺寸，保持比例、留白居中。
 * 返回 dataURL；无 canvas 或尺寸非法时返回 null（调用方回退渐变封面）。
 */
export function drawImageCover(
  src: CanvasImageSource & { width: number; height: number },
  width = COVER_WIDTH,
): string | null {
  if (!canDraw()) return null
  if (!(src.width > 0) || !(src.height > 0)) return null

  const height = Math.round((width * COVER_HEIGHT) / COVER_WIDTH)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, width, height)

  // contain：整页都在，不裁切（封面要能看出这一页长什么样）
  const scale = Math.min(width / src.width, height / src.height)
  const w = src.width * scale
  const h = src.height * scale
  ctx.drawImage(src, (width - w) / 2, (height - h) / 2, w, h)
  return canvas.toDataURL('image/jpeg', 0.9)
}

/**
 * 把一个图片 dataURL（老扫描版记录里存的页位图）缩成封面。
 * 图片来源可能是几百 KB 的整页位图，缩到封面尺寸再存，避免 books 记录变肥。
 */
export async function drawDataUrlCover(
  dataUrl: string,
  width = COVER_WIDTH,
): Promise<string | null> {
  if (!canDraw() || !dataUrl) return null
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('封面图片解码失败'))
      el.src = dataUrl
    })
    return drawImageCover(img, width)
  } catch {
    return null
  }
}
