/**
 * Translator.tsx — 划词翻译浮卡（V6.4，纯呈现组件）。
 *
 * 状态由 ReaderPage 注入：原文、译文（或错误）、目标语言、是否查词。
 * 卡片贴在选区附近（位置由 ReaderPage 算好），不遮挡、不跳页；
 * 关闭即回到阅读，未保存的译文不写库（要留就用「存为想法」）。
 */
import { useEffect, useRef, useState } from 'react'
import { isWordLookup, splitWords, type TranslationResult } from '../core/translate'

export interface TranslateState {
  /** 选中的原文 */
  source: string
  /** 浮卡位置（视口坐标，卡片中心点） */
  x: number
  y: number
  /** 翻译中为 null */
  result: TranslationResult | null
  /** 失败时的可读原因 */
  error: string | null
  /** 失败时的一句话建议 */
  hint?: string
}

export function TranslateCard({
  state,
  onSaveNote,
  onCopy,
  onClose,
}: {
  state: TranslateState
  /** 把译文写进这条批注的想法（V4.0 的 note 字段） */
  onSaveNote: () => void
  onCopy: (text: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)

  // 换了一段新文字就收起"展开原文"
  useEffect(() => {
    setExpanded(false)
  }, [state.source])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const wordMode = isWordLookup(state.source)
  const words = wordMode ? splitWords(state.source) : []

  return (
    <div
      ref={ref}
      className="translate-card"
      style={{ left: state.x, top: state.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="tr-head">
        <span className="tr-badge">
          {state.result ? (state.result.target === 'en' ? '中 → 英' : '英 → 中') : '翻译'}
        </span>
        {words.length > 1 && <span className="tr-words">{words.join(' · ')}</span>}
        <button className="tr-x" title="关闭（Esc）" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className={`tr-source${expanded ? ' expanded' : ''}`} onClick={() => setExpanded((v) => !v)}>
        {state.source}
      </div>

      <div className="tr-body">
        {state.error ? (
          <div className="tr-error">
            {state.error}
            {state.hint && <div className="tr-hint">{state.hint}</div>}
          </div>
        ) : state.result ? (
          <>
            <div className="tr-result">
              {state.result.text}
              {/* 多义词：接口结果之外再列本地更常见的义项（如 bank 的"岸；堤"） */}
              {state.result.alt && (
                <span className="tr-alt" title="另一常见义项（多见于本书这类文学文本）">
                  也作：{state.result.alt}
                </span>
              )}
            </div>
            {/* 单词的单条译文常常偏"词源义"（beginning → 源）：给出所在整句的译文做语境对照 */}
            {state.result.context && (
              <div className="tr-context" title="该词所在整句的翻译">
                <span className="tr-ctx-tag">整句</span>
                {state.result.context}
              </div>
            )}
          </>
        ) : (
          <div className="tr-loading">
            <span className="import-spinner" />
            翻译中…
          </div>
        )}
      </div>

      <div className="tr-actions">
        {state.result && (
          <>
            <button className="sel-btn" onClick={() => onCopy(state.result!.text)}>
              复制译文
            </button>
            <button className="sel-btn primary" onClick={onSaveNote} title="写入这条批注的想法">
              存为想法
            </button>
          </>
        )}
        {state.error && (
          <button className="sel-btn" onClick={onClose}>
            知道了
          </button>
        )}
      </div>
    </div>
  )
}
