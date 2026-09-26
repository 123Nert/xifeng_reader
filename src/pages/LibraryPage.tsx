/**
 * LibraryPage.tsx — 书库（产品 P0：导入、列表、删除）。
 * 导入流程：读 ArrayBuffer → 编码探测解码 → 入库 → 刷新列表。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { purifyText } from '../core/purify'
import { importBook, ImportError, FORMAT_LABELS } from '../core/importers'
import {
  addBook,
  deleteBook,
  exportBackup,
  getReadingStats,
  importBackup,
  listLibrary,
  renameBook,
  type LibraryEntry,
  type ReadingStats,
} from '../core/bookRepository'
import { applySettingsToDocument, loadSettings, saveSettings } from '../core/settings'

/** 导入编码选项（V1.3：自动探测之外的兜底手段）。 */
const CHARSET_OPTIONS = [
  { value: 'auto', label: '自动识别编码' },
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'gb18030', label: 'GB18030 / GBK' },
  { value: 'big5', label: 'Big5 繁体' },
  { value: 'utf-16le', label: 'UTF-16LE' },
  { value: 'utf-16be', label: 'UTF-16BE' },
]

/** 封面配色：按 id 稳定选取，让同一本书每次渲染颜色一致。 */
const COVER_PALETTE = [
  ['#667eea', '#764ba2'],
  ['#f5576c', '#f093fb'],
  ['#4facfe', '#00b4d8'],
  ['#fa709a', '#fee140'],
  ['#30cfd0', '#330867'],
  ['#f7971e', '#ffd200'],
  ['#8e2de2', '#4a00e0'],
  ['#11998e', '#38ef7d'],
]

function coverFor(id: string): [string, string] {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return COVER_PALETTE[h % COVER_PALETTE.length] as [string, string]
}

/** 最后阅读时间的友好展示（产品 P0：书库展示最后阅读时间）。 */
function formatLastRead(ts: number | null, now = Date.now()): string {
  if (!ts) return '未读过'
  const MIN = 60e3
  const HOUR = 3600e3
  const DAY = 86400e3
  const diff = now - ts
  if (diff < MIN) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`
  const d = new Date(ts)
  const m = d.getMonth() + 1
  const day = d.getDate()
  return `${d.getFullYear()}-${m < 10 ? '0' + m : m}-${day < 10 ? '0' + day : day}`
}

export default function LibraryPage({ onOpen }: { onOpen: (bookId: string) => void }) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [progressText, setProgressText] = useState('')
  const [charsetChoice, setCharsetChoice] = useState('auto')
  const [purifyOn, setPurifyOn] = useState(true)
  const [stats, setStats] = useState<ReadingStats | null>(null)
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<'recent' | 'added' | 'title'>('recent')
  const [manage, setManage] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)
  const backupInputRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  const refresh = useCallback(async () => {
    setEntries(await listLibrary())
    setStats(await getReadingStats())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 导入单个文件（V5.0：多格式 + 净化 + 元信息）。返回给批量导入的成功标记。 */
  const importOneFile = useCallback(
    async (file: File): Promise<{ ok: boolean; title?: string; detail?: string }> => {
      try {
        const buffer = await file.arrayBuffer()
        const result = await importBook(file.name, buffer, (info) => {
          setProgressText(
            info.total ? `${info.phase} ${info.current}/${info.total}` : info.phase,
          )
        })

        // 净化推广行（V1.3；对 EPUB 等的正文同样适用）
        let content = result.text
        let removed = 0
        if (purifyOn) {
          const report = purifyText(content)
          content = report.text
          removed = report.removed
        }

        await addBook({
          id: crypto.randomUUID(),
          title: result.title,
          content,
          size: file.size,
          charset: result.charset ?? result.format.toUpperCase(),
          importedAt: Date.now(),
          format: result.format,
          cover: result.cover,
          tocEntries: result.tocEntries,
          author: result.author,
          language: result.language,
        })

        const bits = [FORMAT_LABELS[result.format]]
        if (result.charset && result.format === 'txt') bits.push(result.charset.toUpperCase())
        if (removed > 0) bits.push(`净化 ${removed} 行`)
        if (result.tocEntries) bits.push(`${result.tocEntries.length} 章`)
        if (result.warnings.length > 0) bits.push(`${result.warnings.length} 处警告`)
        return { ok: true, title: result.title, detail: bits.join(' · ') }
      } catch (err) {
        const msg =
          err instanceof ImportError
            ? `${err.message}${err.hint ? `——${err.hint}` : ''}`
            : '导入失败，请重试'
        console.error(err)
        return { ok: false, title: file.name, detail: msg }
      }
    },
    [purifyOn],
  )

  /** 批量导入：逐个处理，单个失败不影响其余（V5.0-a）。 */
  const importFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      setImporting(true)
      let okCount = 0
      let lastDetail = ''
      const failures: string[] = []
      try {
        for (let i = 0; i < files.length; i++) {
          setProgressText(
            files.length > 1 ? `导入中 ${i + 1}/${files.length}：${files[i].name}` : '正在导入…',
          )
          const r = await importOneFile(files[i])
          if (r.ok) {
            okCount++
            lastDetail = r.detail ?? ''
          } else {
            failures.push(`《${r.title}》：${r.detail}`)
          }
        }
        await refresh()
        if (files.length === 1 && failures.length === 0) {
          showToast(`已导入${lastDetail ? ' · ' + lastDetail : ''}`)
        } else if (failures.length === 0) {
          showToast(`已导入 ${okCount} 本书`)
        } else {
          showToast(
            okCount > 0
              ? `成功 ${okCount} 本，失败 ${failures.length} 本：${failures[0]}`
              : failures[0],
          )
        }
      } finally {
        setImporting(false)
        setProgressText('')
      }
    },
    [importOneFile, refresh, showToast],
  )

  const removeBook = useCallback(
    async (entry: LibraryEntry) => {
      if (!window.confirm(`确定要删除《${entry.title}》吗？删除后不可恢复。`)) return
      await deleteBook(entry.id)
      await refresh()
      showToast(`已删除《${entry.title}》`)
    },
    [refresh, showToast],
  )

  /** 重命名（V2.0）。 */
  const handleRename = useCallback(
    async (entry: LibraryEntry) => {
      const name = window.prompt('修改书名', entry.title)
      if (name == null || name.trim() === '' || name.trim() === entry.title) return
      await renameBook(entry.id, name)
      await refresh()
      showToast('已重命名')
    },
    [refresh, showToast],
  )

  /** 批量删除（V2.0）。 */
  const handleBatchDelete = useCallback(async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    if (!window.confirm(`确定要删除选中的 ${ids.length} 本书吗？删除后不可恢复。`)) return
    for (const id of ids) await deleteBook(id)
    setSelected(new Set())
    setManage(false)
    await refresh()
    showToast(`已删除 ${ids.length} 本书`)
  }, [selected, refresh, showToast])

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /** 导出全量备份（V2.0）。 */
  const handleExport = useCallback(async () => {
    try {
      const data = await exportBackup(loadSettings())
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `xifeng-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      showToast('备份已导出')
    } catch (err) {
      console.error(err)
      showToast('导出失败')
    }
  }, [showToast])

  /** 导入备份（按 id 覆盖合并，V2.0）。 */
  const handleImportBackup = useCallback(
    async (file: File) => {
      try {
        const data = JSON.parse(await file.text())
        const report = await importBackup(data)
        if (data.settings) {
          saveSettings(data.settings)
          applySettingsToDocument(data.settings)
        }
        await refresh()
        showToast(`已导入 ${report.books} 本书 · ${report.bookmarks} 个书签`)
      } catch (err) {
        showToast(err instanceof Error ? err.message : '导入失败')
      }
    },
    [refresh, showToast],
  )

  const list = entries ?? []
  const kw = query.trim().toLowerCase()
  const visible = [...list]
    .filter((e) => !kw || e.title.toLowerCase().includes(kw))
    .sort((a, b) => {
      if (sortBy === 'added') return b.importedAt - a.importedAt
      if (sortBy === 'title') return a.title.localeCompare(b.title, 'zh')
      return (b.lastReadAt ?? b.importedAt) - (a.lastReadAt ?? a.importedAt)
    })

  return (
    <section
      className="library"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const files = [...e.dataTransfer.files]
        if (files.length > 0) void importFiles(files)
      }}
    >
      <header className="lib-header">
        <div className="lib-heading">
          <h1>xifeng 阅读</h1>
          <p className="sub">本地阅读器 · 支持 TXT / EPUB / MD / HTML · 导入即读，下次接着读</p>
        </div>
        <div className="import-options">
          <label className="import-check">
            <input
              type="checkbox"
              checked={purifyOn}
              onChange={(e) => setPurifyOn(e.target.checked)}
            />
            净化广告
          </label>
          <select
            className="import-select"
            value={charsetChoice}
            onChange={(e) => setCharsetChoice(e.target.value)}
            title="导入时使用的文本编码"
          >
            {CHARSET_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            className="btn primary"
            title="支持 TXT / EPUB / Markdown / HTML，可多选"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            {importing ? '导入中…' : '＋ 导入书籍'}
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.epub,.md,.markdown,.html,.htm,.xhtml,text/plain,application/epub+zip,text/markdown,text/html"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            if (files.length > 0) void importFiles(files)
            e.target.value = ''
          }}
        />
      </header>

      <div className="lib-toolbar">
        <span className="stats-strip" title="阅读时长统计（页面可见时计时）">
          📊{' '}
          {stats
            ? `今日 ${stats.todayMinutes} 分钟 · 本周 ${stats.weekMinutes} 分钟 · 累计 ${stats.totalMinutes} 分钟`
            : '统计加载中…'}
        </span>
        <input
          className="search-input lib-search"
          placeholder="搜索书名…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="import-select"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          title="排序方式"
        >
          <option value="recent">最近阅读</option>
          <option value="added">添加时间</option>
          <option value="title">按书名</option>
        </select>
        <span className="flex-spacer" />
        <button
          className={`btn chip${manage ? ' active' : ''}`}
          onClick={() => {
            setManage((v) => !v)
            setSelected(new Set())
          }}
        >
          {manage ? '完成' : '管理'}
        </button>
        <button className="btn chip" onClick={() => void handleExport()}>
          导出备份
        </button>
        <button className="btn chip" onClick={() => backupInputRef.current?.click()}>
          导入备份
        </button>
        <input
          ref={backupInputRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleImportBackup(f)
            e.target.value = ''
          }}
        />
      </div>

      {importing && progressText && (
        <div className="import-progress">
          <span className="import-spinner" />
          {progressText}
        </div>
      )}

      {manage && list.length > 0 && (
        <div className="manage-bar">
          <span>已选 {selected.size} 本</span>
          <button
            className="btn chip"
            onClick={() => setSelected(new Set(visible.map((e) => e.id)))}
          >
            全选
          </button>
          <button
            className="btn chip danger"
            disabled={selected.size === 0}
            onClick={() => void handleBatchDelete()}
          >
            删除选中
          </button>
        </div>
      )}

      {visible.length > 0 && (
        <main className="book-grid">
          {visible.map((entry) => {
            const percent =
              entry.charCount > 0
                ? Math.min(100, Math.round((entry.charIndex / entry.charCount) * 100))
                : 0
            const [c1, c2] = coverFor(entry.id)
            return (
              <div
                key={entry.id}
                className={`book-card${manage && selected.has(entry.id) ? ' selected' : ''}`}
                onClick={() => (manage ? toggleSelected(entry.id) : onOpen(entry.id))}
              >
                {manage && (
                  <input type="checkbox" className="card-check" checked={selected.has(entry.id)} readOnly />
                )}
                <div
                  className="book-cover"
                  style={
                    entry.cover
                      ? { backgroundImage: `url(${entry.cover})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                      : { background: `linear-gradient(135deg, ${c1}, ${c2})` }
                  }
                >
                  {entry.format && entry.format !== 'txt' && (
                    <span className="cover-format">{FORMAT_LABELS[entry.format]}</span>
                  )}
                  <span className="cover-title">{entry.title}</span>
                </div>
                <div className="book-meta">
                  <div className="book-title" title={entry.title}>
                    {entry.title}
                  </div>
                  <div className="book-sub">
                    {entry.author ? `${entry.author} · ` : ''}
                    {entry.charIndex > 0 ? `已读 ${percent}% · ` : '未读 · '}
                    {entry.lastReadAt ? formatLastRead(entry.lastReadAt) : '刚导入'}
                  </div>
                </div>
                <div className="book-progress">
                  <div className="fill" style={{ width: `${percent}%` }} />
                </div>
                {!manage && (
                  <div className="book-actions">
                    <button
                      className="book-action"
                      title="重命名"
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleRename(entry)
                      }}
                    >
                      ✎
                    </button>
                    <button
                      className="book-action"
                      title="删除这本书"
                      onClick={(e) => {
                        e.stopPropagation()
                        void removeBook(entry)
                      }}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </main>
      )}

      {visible.length === 0 && list.length > 0 && (
        <div className="empty">
          <p className="empty-title">没有匹配的书名</p>
        </div>
      )}

      {list.length === 0 && !importing && (
        <div className="empty">
          <div className="empty-icon">📖</div>
          <p className="empty-title">书架还是空的</p>
          <p className="sub">点击右上角「导入书籍」，或把文件拖到这里（TXT / EPUB / MD / HTML）</p>
        </div>
      )}

      {dragOver && <div className="drop-hint">松开以导入书籍（TXT / EPUB / MD / HTML）</div>}
      {toast && <div className="toast">{toast}</div>}
    </section>
  )
}
