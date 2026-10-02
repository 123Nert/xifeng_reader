/**
 * speech.ts — 生词发音 / TTS 朗读的浏览器封装（V6.8）。
 *
 * Web Speech API 不可单测也不存在于 Node，所以这里刻意薄：
 * - 可测的部分只有 pickSpeechLang（复用 translate.looksChinese）；
 * - speakText / stopSpeaking 是 3 行浏览器调用，出错静默降级 ——
 *   发音是锦上添花，绝不能让阅读/复习主流程报错。
 */

import { looksChinese } from './translate'

/** 按文本语言挑 BCP-47 语音标签：中文词 zh-CN，西文 en-US。 */
export function pickSpeechLang(text: string): string {
  return looksChinese(text) ? 'zh-CN' : 'en-US'
}

export interface SpeakOptions {
  /** 语速（0.5~2），默认 1 */
  rate?: number
  /** 强制指定语言标签（书籍级朗读用）；缺省按文本自动判断 */
  lang?: string
}

/** 朗读一段文本。先 cancel 再 speak：连续点 🔊 不叠音。环境不支持时静默跳过。 */
export function speakText(text: string, opts: SpeakOptions = {}): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  const trimmed = text.trim()
  if (!trimmed) return
  try {
    const synth = window.speechSynthesis
    synth.cancel()
    const utterance = new SpeechSynthesisUtterance(trimmed.slice(0, 300))
    utterance.lang = opts.lang ?? pickSpeechLang(trimmed)
    const rate = opts.rate
    if (typeof rate === 'number' && Number.isFinite(rate)) {
      utterance.rate = Math.min(2, Math.max(0.5, rate))
    }
    synth.speak(utterance)
  } catch {
    // 发音失败不影响主流程
  }
}

/** 停止当前朗读（离开页面 / 翻页时调用）。 */
export function stopSpeaking(): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  try {
    window.speechSynthesis.cancel()
  } catch {
    // 同上，静默
  }
}
