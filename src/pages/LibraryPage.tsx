/**
 * LibraryPage.tsx — 书库（产品 P0：导入、列表、删除）。
 * 导入流程：读 ArrayBuffer → 编码探测解码 → 入库 → 刷新列表。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { decodeText } from '../core/encoding'
import { purifyText } from '../core/purify'
import { addBook, deleteBook, listLibrary, type LibraryEntry } from '../core/bookRepository'

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
  const [charsetChoice, setCharsetChoice] = useState('auto')
  const [purifyOn, setPurifyOn] = useState(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  const refresh = useCallback(async () => {
    setEntries(await listLibrary())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const importFile = useCallback(
    async (file: File) => {
      if (!/\.txt$/i.test(file.name)) {
        showToast('目前仅支持导入 TXT 文件')
        return
      }
      setImporting(true)
      try {
        const buffer = await file.arrayBuffer()
        const { text: decoded, charset } = decodeText(buffer, { charset: charsetChoice })
        // 导入时净化推广行（V1.3）：原始文件仍在用户手中，可关掉开关重新导入
        let content = decoded
        let removed = 0
        if (purifyOn) {
          const report = purifyText(decoded)
          content = report.text
          removed = report.removed
        }
        const title = file.name.replace(/\.txt$/i, '')
        await addBook({
          id: crypto.randomUUID(),
          title,
          content,
          size: file.size,
          charset,
          importedAt: Date.now(),
        })
        await refresh()
        showToast(
          `已导入《${title}》· ${charset.toUpperCase()}${removed > 0 ? ` · 净化 ${removed} 行` : ''}`,
        )
      } catch (err) {
        console.error(err)
        showToast('导入失败，请重试')
      } finally {
        setImporting(false)
      }
    },
    [refresh, showToast, charsetChoice, purifyOn],
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

  const list = entries ?? []
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
        const file = e.dataTransfer.files[0]
        if (file) void importFile(file)
      }}
    >
      <header className="lib-header">
        <div className="lib-heading">
          <h1>xifeng 阅读</h1>
          <p className="sub">本地 TXT 阅读器 · 导入即读，下次接着读</p>
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
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            {importing ? '导入中…' : '＋ 导入 TXT'}
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,text/plain"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void importFile(file)
            e.target.value = ''
          }}
        />
      </header>

      {list.length > 0 && (
        <main className="book-grid">
          {list.map((entry) => {
            const percent = entry.charCount > 0 ? Math.min(100, Math.round((entry.charIndex / entry.charCount) * 100)) : 0
            const [c1, c2] = coverFor(entry.id)
            return (
              <div key={entry.id} className="book-card" onClick={() => onOpen(entry.id)}>
                <div className="book-cover" style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}>
                  <span className="cover-title">{entry.title}</span>
                </div>
                <div className="book-meta">
                  <div className="book-title" title={entry.title}>
                    {entry.title}
                  </div>
                  <div className="book-sub">
                    {entry.charIndex > 0 ? `已读 ${percent}% · ` : '未读 · '}
                    {entry.lastReadAt ? formatLastRead(entry.lastReadAt) : '刚导入'}
                  </div>
                </div>
                <div className="book-progress">
                  <div className="fill" style={{ width: `${percent}%` }} />
                </div>
                <button
                  className="book-delete"
                  title="删除这本书"
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeBook(entry)
                  }}
                >
                  ✕
                </button>
              </div>
            )
          })}
        </main>
      )}

      {list.length === 0 && !importing && (
        <div className="empty">
          <div className="empty-icon">📖</div>
          <p className="empty-title">书架还是空的</p>
          <p className="sub">点击右上角「导入 TXT」，或把文件拖到这里</p>
        </div>
      )}

      {dragOver && <div className="drop-hint">松开以导入 TXT 文件</div>}
      {toast && <div className="toast">{toast}</div>}
    </section>
  )
}
