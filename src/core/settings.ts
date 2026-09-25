/**
 * settings.ts — 阅读设置读写（localStorage，全局生效）。
 *
 * localStorage `xifeng.settings` → { fontSize, lineHeight }。
 * 深色主题（V1.1）届时在此扩展字段，并在 CSS 增加一组变量即可。
 */

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
}

export const FONT_MIN = 14
export const FONT_MAX = 30
export const FONT_STEP = 2
export const FONT_SIZE_DEFAULT = 18

export const LINE_HEIGHT_STEPS = [1.5, 1.75, 2, 2.25] as const
export const LINE_HEIGHT_DEFAULT: number = 1.75

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
      return {
        fontSize: Number.isFinite(fontSize) ? fontSize : FONT_SIZE_DEFAULT,
        lineHeight: LINE_HEIGHT_STEPS.includes(lineHeight as (typeof LINE_HEIGHT_STEPS)[number])
          ? lineHeight
          : LINE_HEIGHT_DEFAULT,
      }
    }
  } catch {
    // 数据损坏时静默回退默认值
  }
  return { fontSize: FONT_SIZE_DEFAULT, lineHeight: LINE_HEIGHT_DEFAULT }
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

/** 把设置写回根元素 CSS 变量；分页测量与正文渲染共用同一组变量，保证"所见即所测"。 */
export function applySettingsToDocument(settings: ReaderSettings): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--content-font-size', settings.fontSize + 'px')
  document.documentElement.style.setProperty('--content-line-height', String(settings.lineHeight))
}
