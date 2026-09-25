/**
 * ReaderMenu.tsx — 阅读菜单（V1.2）：目录 / 书签 / 搜索 / 设置 四页签。
 * 底部弹层形态；全部数据与操作由 ReaderPage 注入，本组件只负责呈现。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { Toc } from '../core/toc'
import type { BookmarkRecord } from '../core/bookRepository'
import type { SearchHit } from '../core/search'
import { THEME_LABELS, THEME_NAMES, type ReaderSettings, type ThemeName } from '../core/settings'

export type MenuTab = 'toc' | 'marks' | 'search' | 'settings'

interface Props {
  open: boolean
  tab: MenuTab
  onTabChange: (tab: MenuTab) => void
  onClose: () => void

  toc: Toc
  chapterIdx: number
  totalChars: number
  patternDraft: string
  onPatternDraft: (value: string) => void
  onApplyPattern: () => void

  bookmarks: BookmarkRecord[]
  onAddBookmark: () => void
  onDeleteBookmark: (id: string) => void

  onJumpOffset: (charIndex: number) => void
  onSearch: (query: string) => SearchHit[]

  settings: ReaderSettings
  onFontDelta: (delta: -1 | 1) => void
  onLineHeight: () => void
  onTheme: (theme: ThemeName) => void
}

const TABS: Array<{ key: MenuTab; label: string }> = [
  { key: 'toc', label: '目录' },
  { key: 'marks', label: '书签' },
  { key: 'search', label: '搜索' },
  { key: 'settings', label: '设置' },
]

/** 在摘要文本里高亮命中词（大小写不敏感）。 */
function highlightExcerpt(excerpt: string, query: string): ReactNode {
  const q = query.trim()
  if (!q) return excerpt
  const lower = excerpt.toLowerCase()
  const needle = q.toLowerCase()
  const parts: ReactNode[] = []
  let i = 0
  let k = 0
  for (;;) {
    const idx = lower.indexOf(needle, i)
    if (idx < 0) {
      parts.push(excerpt.slice(i))
      break
    }
    parts.push(excerpt.slice(i, idx))
    parts.push(<mark key={k++}>{excerpt.slice(idx, idx + q.length)}</mark>)
    i = idx + q.length
  }
  return parts
}

export default function ReaderMenu(props: Props) {
  const { open, tab, onTabChange, onClose } = props
  const [searchInput, setSearchInput] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)

  // 打开目录时把当前章节滚到可见区域中央
  useEffect(() => {
    if (!open || tab !== 'toc') return
    document.querySelector('.toc-item.active')?.scrollIntoView({ block: 'center' })
  }, [open, tab, props.chapterIdx])

  if (!open) return null

  const pct = (charIndex: number) =>
    props.totalChars > 1 ? Math.round((charIndex / (props.totalChars - 1)) * 100) + '%' : '0%'

  const runSearch = () => {
    setHits(props.onSearch(searchInput))
  }

  return (
    <div className="menu-mask" onClick={onClose}>
      <aside className="menu-sheet" onClick={(e) => e.stopPropagation()}>
        <nav className="menu-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`menu-tab${tab === t.key ? ' active' : ''}`}
              onClick={() => onTabChange(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="menu-body">
          {tab === 'toc' && (
            <>
              {props.toc.entries.length > 0 ? (
                <div className="toc-list">
                  {props.toc.entries.map((entry, i) => (
                    <button
                      key={entry.charIndex}
                      className={`toc-item${i === props.chapterIdx ? ' active' : ''}`}
                      onClick={() => props.onJumpOffset(entry.charIndex)}
                    >
                      <span className="toc-name">{entry.title}</span>
                      <span className="toc-percent">{pct(entry.charIndex)}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="menu-empty">未识别到章节，可在下方输入自定义正则</div>
              )}
              <footer className="toc-footer">
                <input
                  className="toc-pattern-input"
                  value={props.patternDraft}
                  placeholder="自定义章节正则（可选，如 ^\\d+$）"
                  onChange={(e) => props.onPatternDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') props.onApplyPattern()
                  }}
                />
                <button className="btn chip" onClick={props.onApplyPattern}>
                  应用
                </button>
                {props.toc.error && <div className="toc-error">{props.toc.error}</div>}
              </footer>
            </>
          )}

          {tab === 'marks' && (
            <div className="bm-list">
              <div className="bm-toolbar">
                <button className="btn chip" onClick={props.onAddBookmark}>
                  ＋ 在当前位置添加书签
                </button>
                <span className="toc-count">{props.bookmarks.length} 个</span>
              </div>
              {props.bookmarks.length === 0 ? (
                <div className="menu-empty">还没有书签，读书时随手加一个吧</div>
              ) : (
                props.bookmarks.map((b) => (
                  <div key={b.id} className="bm-item" onClick={() => props.onJumpOffset(b.charIndex)}>
                    <div className="bm-main">
                      <span className="bm-excerpt">{b.excerpt || '（空白处）'}</span>
                      <span className="toc-percent">{pct(b.charIndex)}</span>
                    </div>
                    <div className="bm-sub">{new Date(b.createdAt).toLocaleString()}</div>
                    <button
                      className="bm-delete"
                      title="删除书签"
                      onClick={(e) => {
                        e.stopPropagation()
                        props.onDeleteBookmark(b.id)
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'search' && (
            <div className="search-pane">
              <div className="search-bar">
                <input
                  className="search-input"
                  value={searchInput}
                  placeholder="在全书搜索（英文忽略大小写）"
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') runSearch()
                  }}
                />
                <button className="btn chip" onClick={runSearch}>
                  搜索
                </button>
              </div>
              {hits === null ? (
                <div className="menu-empty">输入关键词，全文即扫即得</div>
              ) : hits.length === 0 ? (
                <div className="menu-empty">没有找到匹配的内容</div>
              ) : (
                <>
                  <div className="search-count">{hits.length} 处命中</div>
                  <div className="search-results">
                    {hits.map((h) => (
                      <button
                        key={h.charIndex}
                        className="toc-item search-hit"
                        onClick={() => props.onJumpOffset(h.charIndex)}
                      >
                        <span className="toc-name">
                          …{highlightExcerpt(h.excerpt, searchInput)}…
                        </span>
                        <span className="toc-percent">{pct(h.charIndex)}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'settings' && (
            <div className="settings-pane">
              <div className="set-row">
                <span className="set-label">字号</span>
                <div className="set-value">
                  <button className="btn chip" onClick={() => props.onFontDelta(-1)}>
                    A−
                  </button>
                  <span className="set-current">{props.settings.fontSize}px</span>
                  <button className="btn chip" onClick={() => props.onFontDelta(1)}>
                    A＋
                  </button>
                </div>
              </div>
              <div className="set-row">
                <span className="set-label">行距</span>
                <div className="set-value">
                  <button className="btn chip" onClick={props.onLineHeight}>
                    {props.settings.lineHeight}（点击切换）
                  </button>
                </div>
              </div>
              <div className="set-row">
                <span className="set-label">主题</span>
                <div className="set-value">
                  {THEME_NAMES.map((t) => (
                    <button
                      key={t}
                      className={`btn chip${props.settings.theme === t ? ' active' : ''}`}
                      onClick={() => props.onTheme(t)}
                    >
                      {THEME_LABELS[t]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
