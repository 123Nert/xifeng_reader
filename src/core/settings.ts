import { TRANSLATE_TARGETS, type TranslateTarget } from './translate'

/**
 * settings.ts — 阅读设置读写（localStorage，全局生效）。
 *
 * localStorage `xifeng.settings` → {
 *   fontSize, lineHeight, theme,
 *   paraSpacing, pageMargin, indent, align,   // V1.3 排版
 *   fontFamily, customFontName,               // V1.3 字体
 *   translateTarget,                          // V6.4 划词翻译目标语言
 * }。
 */

// V6.4：划词翻译目标语言的定义在 core/translate.ts，这里只做设置项读写
export { TRANSLATE_TARGETS, TRANSLATE_TARGET_LABELS, type TranslateTarget } from './translate'

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
  theme: ThemeName
  /** 段间距（em），0 = 紧凑 */
  paraSpacing: number
  /** 页边距档位 */
  pageMargin: MarginName
  /** 段首缩进两字 */
  indent: boolean
  /** 两端对齐 */
  align: 'start' | 'justify'
  /** 正文字体预设 */
  fontFamily: FontFamilyName
  /** 自定义字体族名（字体文件仅本会话内加载） */
  customFontName?: string
  /** 自动翻页间隔（秒） */
  autoPageSeconds: number
  /** 阅读模式（V2.1）：分页 / 连续滚动 */
  pageMode: PageModeName
  /** V6.1：扫描版 PDF 位图缩放（1 = 适应视口，可放大到 3） */
  scanZoom: number
  /** V6.4：划词翻译的目标语言（auto = 英文→中文、中文→英文） */
  translateTarget: TranslateTarget
}

export const FONT_MIN = 14
export const FONT_MAX = 30
export const FONT_STEP = 2
export const FONT_SIZE_DEFAULT = 18

export const LINE_HEIGHT_STEPS = [1.5, 1.75, 2, 2.25] as const
export const LINE_HEIGHT_DEFAULT: number = 1.75

export const THEME_NAMES = ['light', 'sepia', 'dark'] as const
export type ThemeName = (typeof THEME_NAMES)[number]
export const THEME_DEFAULT: ThemeName = 'light'
export const THEME_LABELS: Record<ThemeName, string> = { light: '日间', sepia: '护眼', dark: '夜间' }

/** 循环切换主题：日间 → 护眼 → 夜间 → 日间。 */
export function nextTheme(current: ThemeName): ThemeName {
  const i = THEME_NAMES.indexOf(current)
  return THEME_NAMES[(i + 1) % THEME_NAMES.length]
}

// ---------- V1.3 排版 ----------

export const PARA_SPACING_STEPS = [0, 0.5, 1] as const
export const PARA_SPACING_DEFAULT: number = 0.5
export const PARA_SPACING_LABELS = ['紧凑', '适中', '宽松']

/** 循环切换段距档位。 */
export function nextParaSpacing(current: number): number {
  const i = PARA_SPACING_STEPS.indexOf(current as (typeof PARA_SPACING_STEPS)[number])
  return PARA_SPACING_STEPS[(i + 1) % PARA_SPACING_STEPS.length]
}

export const MARGIN_NAMES = ['narrow', 'medium', 'wide'] as const
export type MarginName = (typeof MARGIN_NAMES)[number]
export const MARGIN_DEFAULT: MarginName = 'medium'
export const MARGIN_LABELS: Record<MarginName, string> = { narrow: '窄', medium: '中', wide: '宽' }
/** 各档位对应的正文区水平内边距（px）。 */
export const MARGIN_PX: Record<MarginName, number> = { narrow: 14, medium: 26, wide: 42 }

export function nextMargin(current: MarginName): MarginName {
  const i = MARGIN_NAMES.indexOf(current)
  return MARGIN_NAMES[(i + 1) % MARGIN_NAMES.length]
}

// ---------- V1.3 字体 ----------

export const FONT_FAMILY_NAMES = ['serif', 'sans', 'kai', 'custom'] as const
export type FontFamilyName = (typeof FONT_FAMILY_NAMES)[number]
export const FONT_FAMILY_DEFAULT: FontFamilyName = 'serif'
export const FONT_FAMILY_LABELS: Record<FontFamilyName, string> = {
  serif: '宋体',
  sans: '黑体',
  kai: '楷体',
  custom: '自定义',
}

/** 各字体预设对应的 font-family 栈；custom 走运行时注册的字体族。 */
export const FONT_FAMILY_STACKS: Record<FontFamilyName, string> = {
  serif: "Georgia, 'Nimbus Roman', 'Songti SC', 'Noto Serif CJK SC', 'SimSun', serif",
  sans: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  kai: "'Kaiti SC', KaiTi, STKaiti, 'Noto Serif CJK SC', serif",
  custom: "var(--custom-font-family), 'Songti SC', 'Noto Serif CJK SC', serif",
}

// ---------- V2.0 自动翻页 ----------

export const AUTO_PAGE_SECONDS = [5, 10, 15, 30] as const
export const AUTO_PAGE_DEFAULT: number = 10

// ---------- V2.1 阅读模式 ----------

export const PAGE_MODE_NAMES = ['paged', 'scroll'] as const
export type PageModeName = (typeof PAGE_MODE_NAMES)[number]
export const PAGE_MODE_DEFAULT: PageModeName = 'paged'
export const PAGE_MODE_LABELS: Record<PageModeName, string> = { paged: '分页', scroll: '滚动' }

// ---------- V6.1 扫描版位图缩放 ----------

export const SCAN_ZOOM_MIN = 1
export const SCAN_ZOOM_MAX = 4
export const SCAN_ZOOM_STEP = 0.5
export const SCAN_ZOOM_DEFAULT = 1

export function clampScanZoom(z: number): number {
  if (!Number.isFinite(z)) return SCAN_ZOOM_DEFAULT
  return Math.min(SCAN_ZOOM_MAX, Math.max(SCAN_ZOOM_MIN, Math.round(z * 2) / 2))
}

/** 目标语言只接受三个合法值，其余回退 auto（兼容旧数据）。 */
export function clampTranslateTarget(v: unknown): TranslateTarget {
  return TRANSLATE_TARGETS.includes(v as TranslateTarget) ? (v as TranslateTarget) : 'auto'
}

const STORAGE_KEY = 'xifeng.settings'

export function clampFontSize(size: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, size))
}

/** 循环切换到下一个行距档位。 */
export function nextLineHeight(current: number): number {
  const i = LINE_HEIGHT_STEPS.indexOf(current as (typeof LINE_HEIGHT_STEPS)[number])
  return LINE_HEIGHT_STEPS[(i + 1) % LINE_HEIGHT_STEPS.length]
}

/** 读取设置；缺失或损坏时返回默认值（未知字段逐项回退，兼容旧版本数据）。 */
export function loadSettings(storage: Pick<Storage, 'getItem'> = localStorage): ReaderSettings {
  const fallback: ReaderSettings = {
    fontSize: FONT_SIZE_DEFAULT,
    lineHeight: LINE_HEIGHT_DEFAULT,
    theme: THEME_DEFAULT,
    paraSpacing: PARA_SPACING_DEFAULT,
    pageMargin: MARGIN_DEFAULT,
    indent: false,
    align: 'start',
    fontFamily: FONT_FAMILY_DEFAULT,
    autoPageSeconds: AUTO_PAGE_DEFAULT,
    pageMode: PAGE_MODE_DEFAULT,
    scanZoom: SCAN_ZOOM_DEFAULT,
    translateTarget: 'auto',
  }
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<ReaderSettings>
      const fontSize = clampFontSize(Number(p.fontSize))
      const lineHeight = Number(p.lineHeight)
      const paraSpacing = Number(p.paraSpacing)
      return {
        fontSize: Number.isFinite(fontSize) ? fontSize : fallback.fontSize,
        lineHeight: LINE_HEIGHT_STEPS.includes(lineHeight as (typeof LINE_HEIGHT_STEPS)[number])
          ? lineHeight
          : fallback.lineHeight,
        theme: THEME_NAMES.includes(p.theme as ThemeName) ? (p.theme as ThemeName) : fallback.theme,
        paraSpacing: PARA_SPACING_STEPS.includes(
          paraSpacing as (typeof PARA_SPACING_STEPS)[number],
        )
          ? paraSpacing
          : fallback.paraSpacing,
        pageMargin: MARGIN_NAMES.includes(p.pageMargin as MarginName)
          ? (p.pageMargin as MarginName)
          : fallback.pageMargin,
        indent: typeof p.indent === 'boolean' ? p.indent : fallback.indent,
        align: p.align === 'justify' ? 'justify' : fallback.align,
        fontFamily: FONT_FAMILY_NAMES.includes(p.fontFamily as FontFamilyName)
          ? (p.fontFamily as FontFamilyName)
          : fallback.fontFamily,
        customFontName: typeof p.customFontName === 'string' ? p.customFontName : undefined,
        autoPageSeconds: AUTO_PAGE_SECONDS.includes(
          p.autoPageSeconds as (typeof AUTO_PAGE_SECONDS)[number],
        )
          ? (p.autoPageSeconds as number)
          : fallback.autoPageSeconds,
        pageMode: PAGE_MODE_NAMES.includes(p.pageMode as PageModeName)
          ? (p.pageMode as PageModeName)
          : fallback.pageMode,
        scanZoom: clampScanZoom(Number(p.scanZoom)),
        translateTarget: clampTranslateTarget(p.translateTarget),
      }
    }
  } catch {
    // 数据损坏时静默回退默认值
  }
  return fallback
}

export function saveSettings(
  settings: ReaderSettings,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // 存储不可用（隐私模式等）时忽略，本次会话内仍可读
  }
}

/** 把主题与排版设置写回根元素（CSS 变量 + data-theme）；分页测量与正文渲染共用，保证"所见即所测"。 */
export function applySettingsToDocument(settings: ReaderSettings): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty('--content-font-size', settings.fontSize + 'px')
  root.style.setProperty('--content-line-height', String(settings.lineHeight))
  root.style.setProperty('--content-para-spacing', settings.paraSpacing + 'em')
  root.style.setProperty('--content-padding-x', MARGIN_PX[settings.pageMargin] + 'px')
  root.style.setProperty('--content-indent', settings.indent ? '2em' : '0em')
  root.style.setProperty('--content-align', settings.align)
  root.style.setProperty('--content-font-family', FONT_FAMILY_STACKS[settings.fontFamily])
  root.dataset.theme = settings.theme
}
