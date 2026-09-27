/**
 * settings.ts 单元测试：读写、容错、字号/行距/主题/排版取值域。
 */
import { describe, expect, it } from 'vitest'
import {
  clampFontSize,
  clampScanZoom,
  clampTranslateTarget,
  loadSettings,
  nextLineHeight,
  nextMargin,
  nextParaSpacing,
  nextTheme,
  saveSettings,
  LINE_HEIGHT_DEFAULT,
  LINE_HEIGHT_STEPS,
  FONT_SIZE_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  MARGIN_DEFAULT,
  MARGIN_NAMES,
  PARA_SPACING_DEFAULT,
  PARA_SPACING_STEPS,
  SCAN_ZOOM_MAX,
  THEME_DEFAULT,
  THEME_NAMES,
  type ReaderSettings,
} from './settings'

function makeStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

const DEFAULTS: ReaderSettings = {
  fontSize: FONT_SIZE_DEFAULT,
  lineHeight: LINE_HEIGHT_DEFAULT,
  theme: THEME_DEFAULT,
  paraSpacing: PARA_SPACING_DEFAULT,
  pageMargin: MARGIN_DEFAULT,
  indent: false,
  align: 'start',
  fontFamily: 'serif',
  autoPageSeconds: 10,
  pageMode: 'paged',
  scanZoom: 1,
  translateTarget: 'auto',
}

describe('settings: 读写', () => {
  it('无记录时返回默认值', () => {
    expect(loadSettings(makeStorage())).toEqual(DEFAULTS)
  })

  it('保存后读取往返一致', () => {
    const s: ReaderSettings = {
      fontSize: 22,
      lineHeight: 2,
      theme: 'dark',
      paraSpacing: 1,
      pageMargin: 'wide',
      indent: true,
      align: 'justify',
      fontFamily: 'kai',
      customFontName: 'MyFont',
      autoPageSeconds: 5,
      pageMode: 'scroll',
      scanZoom: 2,
      translateTarget: 'zh-CN',
    }
    const storage = makeStorage()
    saveSettings(s, storage)
    expect(loadSettings(storage)).toEqual(s)
  })

  it('旧版本数据（缺少新字段）逐项回退默认值', () => {
    const storage = makeStorage({
      'xifeng.settings': '{"fontSize":20,"lineHeight":1.75,"theme":"sepia"}',
    })
    expect(loadSettings(storage)).toEqual({ ...DEFAULTS, fontSize: 20, theme: 'sepia' })
  })
})

describe('settings: 容错', () => {
  it('损坏的 JSON 回退默认值', () => {
    const storage = makeStorage({ 'xifeng.settings': '{oops' })
    expect(loadSettings(storage)).toEqual(DEFAULTS)
  })

  it('越界与非法字段被钳制', () => {
    expect(
      loadSettings(
        makeStorage({
          'xifeng.settings':
            '{"fontSize":99,"lineHeight":9,"theme":"pink","paraSpacing":3,"pageMargin":"huge","fontFamily":"mono"}',
        }),
      ),
    ).toEqual({
      ...DEFAULTS,
      fontSize: FONT_MAX,
    })
    expect(loadSettings(makeStorage({ 'xifeng.settings': '{"fontSize":"abc"}' }))).toEqual(DEFAULTS)
  })
})

describe('settings: 取值域', () => {
  it('clampFontSize 限制在 [FONT_MIN, FONT_MAX]', () => {
    expect(clampFontSize(10)).toBe(FONT_MIN)
    expect(clampFontSize(18)).toBe(18)
    expect(clampFontSize(99)).toBe(FONT_MAX)
  })

  it('nextLineHeight 循环遍历所有档位', () => {
    let lh = LINE_HEIGHT_DEFAULT
    const seen = new Set<number>([lh])
    for (let i = 0; i < LINE_HEIGHT_STEPS.length; i++) {
      lh = nextLineHeight(lh)
      seen.add(lh)
    }
    expect(lh).toBe(LINE_HEIGHT_DEFAULT)
    expect(seen.size).toBe(LINE_HEIGHT_STEPS.length)
  })

  it('nextTheme 循环遍历所有主题', () => {
    let theme = THEME_DEFAULT
    const seen = new Set<string>([theme])
    for (let i = 0; i < THEME_NAMES.length; i++) {
      theme = nextTheme(theme)
      seen.add(theme)
    }
    expect(theme).toBe(THEME_DEFAULT)
    expect(seen.size).toBe(THEME_NAMES.length)
  })

  it('nextParaSpacing 循环遍历段距档位', () => {
    let sp = PARA_SPACING_DEFAULT
    const seen = new Set<number>([sp])
    for (let i = 0; i < PARA_SPACING_STEPS.length; i++) {
      sp = nextParaSpacing(sp)
      seen.add(sp)
    }
    expect(sp).toBe(PARA_SPACING_DEFAULT)
    expect(seen.size).toBe(PARA_SPACING_STEPS.length)
  })

  it('nextMargin 循环遍历边距档位', () => {
    let m = MARGIN_DEFAULT
    const seen = new Set<string>([m])
    for (let i = 0; i < MARGIN_NAMES.length; i++) {
      m = nextMargin(m)
      seen.add(m)
    }
    expect(m).toBe(MARGIN_DEFAULT)
    expect(seen.size).toBe(MARGIN_NAMES.length)
  })

  it('clampScanZoom 限制在 [1, 4] 且按 0.5 步进取整', () => {
    expect(clampScanZoom(0.2)).toBe(1)
    expect(clampScanZoom(1)).toBe(1)
    expect(clampScanZoom(1.3)).toBe(1.5)
    expect(clampScanZoom(2.7)).toBe(2.5)
    expect(clampScanZoom(99)).toBe(SCAN_ZOOM_MAX)
    expect(clampScanZoom(-3)).toBe(1)
    expect(clampScanZoom(NaN)).toBe(1)
  })

  it('translateTarget 只接受合法值，其余回退 auto', () => {
    expect(clampTranslateTarget('zh-CN')).toBe('zh-CN')
    expect(clampTranslateTarget('en')).toBe('en')
    expect(clampTranslateTarget('fr')).toBe('auto')
    expect(clampTranslateTarget(undefined)).toBe('auto')
    expect(clampTranslateTarget(42)).toBe('auto')
  })

  it('旧版本数据（缺少 scanZoom）回退默认值 1', () => {
    const storage = makeStorage({
      'xifeng.settings': '{"fontSize":20,"lineHeight":1.75,"theme":"sepia"}',
    })
    expect(loadSettings(storage).scanZoom).toBe(1)
  })
})
