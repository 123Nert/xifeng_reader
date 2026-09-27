/**
 * ReaderMenu.tsx — 阅读菜单（V1.2）：目录 / 书签 / 搜索 / 设置 四页签。
 * 底部弹层形态；全部数据与操作由 ReaderPage 注入，本组件只负责呈现。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Toc } from '../core/toc'
import type { BookmarkRecord } from '../core/bookRepository'
import type { HighlightRecord } from '../core/highlight'
import { NotesList } from './Annotator'
import type { SearchHit } from '../core/search'
import {
  AUTO_PAGE_SECONDS,
  FONT_FAMILY_LABELS,
  FONT_FAMILY_NAMES,
  MARGIN_LABELS,
  PAGE_MODE_LABELS,
  PAGE_MODE_NAMES,
  PARA_SPACING_LABELS,
  TRANSLATE_TARGETS,
  TRANSLATE_TARGET_LABELS,
  PARA_SPACING_STEPS,
  THEME_LABELS,
  THEME_NAMES,
  type FontFamilyName,
  type PageModeName,
  type ReaderSettings,
  type TranslateTarget,
  type ThemeName,
} from '../core/settings'

export type MenuTab = 'toc' | 'marks' | 'notes' | 'search' | 'settings'

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
  highlights: HighlightRecord[]
  onDeleteHighlight: (id: string) => void
  onExportNotes: () => void
  onJumpHighlight: (id: string) => void
  chapterTitles: string[]
  unresolvedIds: Set<string>

  onJumpOffset: (charIndex: number) => void
  onSearch: (query: string) => SearchHit[]

  settings: ReaderSettings
  onFontDelta: (delta: -1 | 1) => void
  onLineHeight: () => void
  onTheme: (theme: ThemeName) => void
  onParaSpacing: () => void
  onMargin: () => void
  onIndentToggle: () => void
  onAlignToggle: () => void
  onFontFamily: (name: FontFamilyName) => void
  onCustomFontFile: (file: File) => void
  onAutoSeconds: (seconds: number) => void
  onPageMode: (mode: PageModeName) => void
  /** V6.4：划词翻译的目标语言 */
  onTranslateTarget: (target: TranslateTarget) => void
}

const TABS: Array<{ key: MenuTab; label: string }> = [
  { key: 'toc', label: '目录' },
  { key: 'marks', label: '书签' },
  { key: 'notes', label: '笔记' },
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

          {tab === 'notes' && (
            <NotesList
              highlights={props.highlights}
              chapterTitles={props.chapterTitles}
              totalChars={props.totalChars}
              onJump={(h) => props.onJumpHighlight(h.id)}
              onDelete={props.onDeleteHighlight}
              onExport={props.onExportNotes}
              unresolvedIds={props.unresolvedIds}
            />
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

          {tab === 'settings' && <SettingsPane {...props} />}
        </div>
      </aside>
    </div>
  )
}

/** 设置页签（V1.2 基础项 + V1.3 排版与字体）。 */
function SettingsPane(props: Props) {
  const { settings } = props
  const fileRef = useRef<HTMLInputElement>(null)
  const spIdx = PARA_SPACING_STEPS.indexOf(settings.paraSpacing as (typeof PARA_SPACING_STEPS)[number])

  return (
    <div className="settings-pane">
      <div className="set-row">
        <span className="set-label">字号</span>
        <div className="set-value">
          <button className="btn chip" onClick={() => props.onFontDelta(-1)}>
            A−
          </button>
          <span className="set-current">{settings.fontSize}px</span>
          <button className="btn chip" onClick={() => props.onFontDelta(1)}>
            A＋
          </button>
        </div>
      </div>
      <div className="set-row">
        <span className="set-label">行距</span>
        <div className="set-value">
          <button className="btn chip" onClick={props.onLineHeight}>
            {settings.lineHeight}（点击切换）
          </button>
        </div>
      </div>
      <div className="set-row">
        <span className="set-label">段距</span>
        <div className="set-value">
          <button className="btn chip" onClick={props.onParaSpacing}>
            {PARA_SPACING_LABELS[spIdx] ?? '适中'}（点击切换）
          </button>
        </div>
      </div>
      <div className="set-row">
        <span className="set-label">边距</span>
        <div className="set-value">
          <button className="btn chip" onClick={props.onMargin}>
            {MARGIN_LABELS[settings.pageMargin]}（点击切换）
          </button>
        </div>
      </div>
      <div className="set-row">
        <span className="set-label">缩进</span>
        <div className="set-value">
          <button className={`btn chip${settings.indent ? ' active' : ''}`} onClick={props.onIndentToggle}>
            段首缩进两字 {settings.indent ? '开' : '关'}
          </button>
        </div>
      </div>
      <div className="set-row">
        <span className="set-label">对齐</span>
        <div className="set-value">
          <button
            className={`btn chip${settings.align === 'justify' ? ' active' : ''}`}
            onClick={props.onAlignToggle}
          >
            {settings.align === 'justify' ? '两端对齐' : '默认对齐'}
          </button>
        </div>
      </div>
      <div className="set-row">
        <span className="set-label">主题</span>
        <div className="set-value">
          {THEME_NAMES.map((t) => (
            <button
              key={t}
              className={`btn chip${settings.theme === t ? ' active' : ''}`}
              onClick={() => props.onTheme(t)}
            >
              {THEME_LABELS[t]}
            </button>
          ))}
        </div>
      </div>
      <div className="set-row">
        <span className="set-label">阅读模式</span>
        <div className="set-value">
          {PAGE_MODE_NAMES.map((m) => (
            <button
              key={m}
              className={`btn chip${settings.pageMode === m ? ' active' : ''}`}
              onClick={() => props.onPageMode(m)}
            >
              {PAGE_MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>
      <div className="set-row">
        <span className="set-label">划词翻译</span>
        <div className="set-value">
          {TRANSLATE_TARGETS.map((t) => (
            <button
              key={t}
              className={`btn chip${settings.translateTarget === t ? ' active' : ''}`}
              onClick={() => props.onTranslateTarget(t)}
              title={TRANSLATE_TARGET_LABELS[t]}
            >
              {t === 'auto' ? '自动' : t === 'zh-CN' ? '译为中文' : '译为英文'}
            </button>
          ))}
        </div>
      </div>
      <div className="set-row">
        <span className="set-label">自动翻页</span>
        <div className="set-value">
          {AUTO_PAGE_SECONDS.map((s) => (
            <button
              key={s}
              className={`btn chip${settings.autoPageSeconds === s ? ' active' : ''}`}
              onClick={() => props.onAutoSeconds(s)}
            >
              {s}秒
            </button>
          ))}
          <span className="set-hint">底栏「▶ 自动」启动</span>
        </div>
      </div>
      <div className="set-row">
        <span className="set-label">字体</span>
        <div className="set-value">
          {FONT_FAMILY_NAMES.map((name) => (
            <button
              key={name}
              className={`btn chip${settings.fontFamily === name ? ' active' : ''}`}
              onClick={() => props.onFontFamily(name)}
            >
              {FONT_FAMILY_LABELS[name]}
            </button>
          ))}
        </div>
      </div>
      <div className="set-row">
        <span className="set-label">自定义字体</span>
        <div className="set-value">
          <button className="btn chip" onClick={() => fileRef.current?.click()}>
            选择字体文件…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".ttf,.otf,.woff,.woff2,font/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) props.onCustomFontFile(f)
              e.target.value = ''
            }}
          />
          <span className="set-hint">支持 TTF/OTF/WOFF，仅本次会话有效</span>
        </div>
      </div>
    </div>
  )
}
