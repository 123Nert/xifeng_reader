/**
 * settings.ts — 阅读设置读写（localStorage，全局生效）。
 *
 * localStorage `xifeng.settings` → { fontSize, lineHeight, theme }。
 */

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
  theme: ThemeName
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

const STORAGE_KEY = 'xifeng.settings'

export function clampFontSize(size: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, size))
}

/** 循环切换到下一个行距档位。 */
export function nextLineHeight(current: number): number {
  const i = LINE_HEIGHT_STEPS.indexOf(current as (typeof LINE_HEIGHT_STEPS)[number])
  return LINE_HEIGHT_STEPS[(i + 1) % LINE_HEIGHT_STEPS.length]
}

/** 读取设置；缺失或损坏时返回默认值。storage 参数便于单测注入。 */
export function loadSettings(storage: Pick<Storage, 'getItem'> = localStorage): ReaderSettings {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ReaderSettings>
      const fontSize = clampFontSize(Number(parsed.fontSize))
      const lineHeight = Number(parsed.lineHeight)
      const theme = THEME_NAMES.includes(parsed.theme as ThemeName)
        ? (parsed.theme as ThemeName)
        : THEME_DEFAULT
      return {
        fontSize: Number.isFinite(fontSize) ? fontSize : FONT_SIZE_DEFAULT,
        lineHeight: LINE_HEIGHT_STEPS.includes(lineHeight as (typeof LINE_HEIGHT_STEPS)[number])
          ? lineHeight
          : LINE_HEIGHT_DEFAULT,
        theme,
      }
    }
  } catch {
    // 数据损坏时静默回退默认值
  }
  return { fontSize: FONT_SIZE_DEFAULT, lineHeight: LINE_HEIGHT_DEFAULT, theme: THEME_DEFAULT }
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
  document.documentElement.style.setProperty('--content-font-size', settings.fontSize + 'px')
  document.documentElement.style.setProperty('--content-line-height', String(settings.lineHeight))
  document.documentElement.dataset.theme = settings.theme
}
