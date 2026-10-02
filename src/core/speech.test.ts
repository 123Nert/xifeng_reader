/**
 * speech.test.ts — 发音语言选择（V6.8）。
 * Web Speech 本体不可在 Node 测，可测的只有语言判定纯函数。
 */
import { describe, expect, it } from 'vitest'
import { pickSpeechLang } from './speech'

describe('speech: 语言选择', () => {
  it('英文词选 en-US', () => {
    expect(pickSpeechLang('beginning')).toBe('en-US')
    expect(pickSpeechLang('river bank')).toBe('en-US')
  })

  it('中文词选 zh-CN', () => {
    expect(pickSpeechLang('河岸')).toBe('zh-CN')
    expect(pickSpeechLang('开始')).toBe('zh-CN')
  })

  it('空串回退 en-US（looksChinese 全 0 返回 false）', () => {
    expect(pickSpeechLang('   ')).toBe('en-US')
  })
})
