/**
 * Annotator.tsx — 批注交互组件（V4.0-b/c）。
 *
 * - SelToolbar：选中文字后浮出，一次给全动作（选色 / 样式 / 写想法）
 * - EditCard：点击已有批注后弹卡（改色 / 换样式 / 改想法 / 复制 / 删除）
 * - 重叠批注：命中多条时顶部显示切换条（对标 KOReader showChooseHighlightDialog）
 *
 * 纯呈现组件：所有状态由 ReaderPage 注入。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_COLOR_LABELS,
  MARK_STYLE_LABELS,
  type HighlightColor,
  type HighlightRecord,
  type MarkStyle,
} from '../core/highlight'

export interface SelInfo {
  x: number
  y: number
  start: number
  end: number
  text: string
}

/** 选中态工具栏：选色即标注，或写想法 / 翻译。 */
export function SelToolbar({
  sel,
  onMark,
  onNote,
  onTranslate,
  onClose,
}: {
  sel: SelInfo
  onMark: (color: HighlightColor, style: MarkStyle) => void
  onNote: (color: HighlightColor, style: MarkStyle) => void
  /** V6.4：把选中文字送去翻译（浮卡接管后续展示） */
  onTranslate?: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [lastColor, setLastColor] = useState<HighlightColor>('yellow')

  useEffect(() => {
    setLastColor('yellow')
  }, [sel.start, sel.end])

  return (
    <div
      ref={ref}
      className="sel-toolbar"
      style={{ left: sel.x, top: sel.y }}
      onMouseDown={(e) => e.preventDefault()} // 防止点击工具栏时清掉选区
    >
      <div className="sel-colors">
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c}
            className={`color-dot color-${c}${lastColor === c ? ' active' : ''}`}
            title={`${HIGHLIGHT_COLOR_LABELS[c]}色高亮`}
            onClick={() => {
              setLastColor(c)
              onMark(c, 'highlight')
            }}
          />
        ))}
      </div>
      <span className="sel-sep" />
      <button className="sel-btn" title="下划线" onClick={() => onMark(lastColor, 'underline')}>
        <span className="style-icon style-underline">A</span>
      </button>
      <button className="sel-btn" title="波浪线" onClick={() => onMark(lastColor, 'squiggly')}>
        <span className="style-icon style-squiggly">A</span>
      </button>
      <button className="sel-btn" title="删除线" onClick={() => onMark(lastColor, 'strikeout')}>
        <span className="style-icon style-strikeout">A</span>
      </button>
      <span className="sel-sep" />
      {onTranslate && (
        <button className="sel-btn" title="翻译选中文字（V6.4）" onClick={onTranslate}>
          🌐 译
        </button>
      )}
      <button className="sel-btn primary" title="标注并写想法" onClick={() => onNote(lastColor, 'highlight')}>
        ✎ 写想法
      </button>
      <button className="sel-btn" title="关闭" onClick={onClose}>
        ✕
      </button>
    </div>
  )
}

/** 批注编辑卡：改色 / 换样式 / 改想法 / 复制 / 删除。 */
export function EditCard({
  items,
  index,
  onSwitch,
  onRecolor,
  onRestyle,
  onSaveNote,
  onDelete,
  onCopy,
  onClose,
}: {
  items: HighlightRecord[]
  index: number
  onSwitch: (next: number) => void
  onRecolor: (color: HighlightColor) => void
  onRestyle: (style: MarkStyle) => void
  onSaveNote: (note: string) => void
  onDelete: () => void
  onCopy: () => void
  onClose: () => void
}) {
  const cur = items[index]
  const [noteDraft, setNoteDraft] = useState(cur?.note ?? '')
  const [saved, setSaved] = useState(false)
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    setNoteDraft(cur?.note ?? '')
    setSaved(false)
  }, [cur?.id, cur?.note])

  // 想法防抖自动保存
  useEffect(() => {
    if (!cur) return
    if (noteDraft === (cur.note ?? '')) return
    window.clearTimeout(saveTimer.current)
    setSaved(false)
    saveTimer.current = window.setTimeout(() => {
      onSaveNote(noteDraft)
      setSaved(true)
    }, 600)
    return () => window.clearTimeout(saveTimer.current)
  }, [noteDraft, cur, onSaveNote])

  if (!cur) return null
  const dot = `var(--hl-${cur.color})`

  return (
    <div className="edit-card" onClick={(e) => e.stopPropagation()}>
      {items.length > 1 && (
        <div className="edit-switch">
          <span style={{ color: dot }}>●</span>
          <span className="edit-switch-label">此处有 {items.length} 条标注</span>
          {items.map((_, i) => (
            <button
              key={i}
              className={`edit-switch-dot${i === index ? ' active' : ''}`}
              onClick={() => onSwitch(i)}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}

      <div className="edit-quote" style={{ borderLeftColor: dot }}>
        {cur.text}
      </div>

      <div className="edit-row">
        <span className="edit-label">颜色</span>
        <div className="edit-colors">
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c}
              className={`color-dot color-${c}${cur.color === c ? ' active' : ''}`}
              title={HIGHLIGHT_COLOR_LABELS[c]}
              onClick={() => onRecolor(c)}
            />
          ))}
        </div>
      </div>

      <div className="edit-row">
        <span className="edit-label">样式</span>
        <div className="edit-styles">
          {(['highlight', 'underline', 'squiggly', 'strikeout'] as MarkStyle[]).map((s) => (
            <button
              key={s}
              className={`sel-btn${cur.style === s ? ' active' : ''}`}
              onClick={() => onRestyle(s)}
            >
              {MARK_STYLE_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="edit-row note-row">
        <span className="edit-label">
          💭 想法{saved && <span className="edit-saved">已保存</span>}
        </span>
        <textarea
          className="edit-note"
          value={noteDraft}
          placeholder="写下此刻的想法…（自动保存）"
          rows={3}
          onChange={(e) => setNoteDraft(e.target.value)}
        />
      </div>

      <div className="edit-actions">
        <button className="btn chip" onClick={onCopy}>
          复制原文
        </button>
        <button className="btn chip danger" onClick={onDelete}>
          删除标注
        </button>
        <span className="flex-spacer" />
        <button className="btn chip" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  )
}

/** 笔记面板：按章节分组 + 筛选 + 搜索。 */
export function NotesList({
  highlights,
  chapterTitles,
  totalChars,
  onJump,
  onDelete,
  onExport,
  unresolvedIds,
}: {
  highlights: HighlightRecord[]
  chapterTitles: string[]
  totalChars: number
  onJump: (h: HighlightRecord) => void
  onDelete: (id: string) => void
  onExport: (onlyWithNotes: boolean) => void
  unresolvedIds: Set<string>
}) {
  const [colorFilter, setColorFilter] = useState<HighlightColor | 'all'>('all')
  const [onlyNotes, setOnlyNotes] = useState(false)
  const [kw, setKw] = useState('')

  const filtered = useMemo(() => {
    const q = kw.trim().toLowerCase()
    return highlights.filter((h) => {
      if (colorFilter !== 'all' && h.color !== colorFilter) return false
      if (onlyNotes && !h.note) return false
      if (q) {
        const hay = (h.text + ' ' + (h.note ?? '')).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [highlights, colorFilter, onlyNotes, kw])

  // 按章节分组（无 chapterIndex 的归入"未归类"）
  const groups = useMemo(() => {
    const map = new Map<number, HighlightRecord[]>()
    for (const h of filtered) {
      const key = h.chapterIndex ?? -1
      const arr = map.get(key) ?? []
      arr.push(h)
      map.set(key, arr)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [filtered])

  const pct = (h: HighlightRecord) =>
    totalChars > 1 ? Math.round((h.start / (totalChars - 1)) * 100) + '%' : '0%'

  return (
    <div className="notes-pane">
      <div className="notes-toolbar">
        <div className="notes-filters">
          <button
            className={`btn chip${colorFilter === 'all' ? ' active' : ''}`}
            onClick={() => setColorFilter('all')}
          >
            全部
          </button>
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c}
              className={`color-dot color-${c}${colorFilter === c ? ' active' : ''}`}
              title={`只看${HIGHLIGHT_COLOR_LABELS[c]}色`}
              onClick={() => setColorFilter(colorFilter === c ? 'all' : c)}
            />
          ))}
          <button
            className={`btn chip${onlyNotes ? ' active' : ''}`}
            title="只看带想法的标注"
            onClick={() => setOnlyNotes((v) => !v)}
          >
            💭 有想法
          </button>
        </div>
        <input
          className="notes-search"
          placeholder="搜索原文或想法…"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
        />
      </div>

      <div className="notes-actions">
        <span className="toc-count">
          共 {filtered.length} 条
          {filtered.length !== highlights.length ? ` / ${highlights.length}` : ''}
        </span>
        <button className="btn chip" onClick={() => onExport(false)}>
          导出 Markdown
        </button>
        <button className="btn chip" onClick={() => onExport(true)} disabled={!highlights.some((h) => h.note)}>
          仅导出有想法
        </button>
      </div>

      <div className="notes-list">
        {filtered.length === 0 ? (
          <div className="menu-empty">
            {highlights.length === 0 ? '选中正文即可添加标注' : '没有符合筛选条件的标注'}
          </div>
        ) : (
          groups.map(([chapterIdx, arr]) => (
            <div key={chapterIdx} className="notes-group">
              <div className="notes-group-title">
                {chapterIdx >= 0 ? chapterTitles[chapterIdx] ?? `第 ${chapterIdx + 1} 章` : '未归类'}
                <span className="toc-count">{arr.length} 条</span>
              </div>
              {arr.map((h) => (
                <div key={h.id} className="note-item" onClick={() => onJump(h)}>
                  <div className="note-main">
                    <span className={`note-dot color-${h.color}`} />
                    <span className="note-style">{MARK_STYLE_LABELS[h.style]}</span>
                    <span className="note-excerpt">{h.text}</span>
                    <span className="toc-percent">{pct(h)}</span>
                  </div>
                  {h.note && <div className="note-thought">💭 {h.note}</div>}
                  {unresolvedIds.has(h.id) && (
                    <div className="note-warn">⚠ 位置待确认（正文可能已变更）</div>
                  )}
                  <div className="note-meta">
                    <span>{new Date(h.createdAt).toLocaleString()}</span>
                    {h.updatedAt && <span>· 已修改</span>}
                  </div>
                  <button
                    className="bm-delete"
                    title="删除标注"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(h.id)
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
