/**
 * App.tsx — 入口：书库 / 阅读两个视图切换（技术方案：暂不引入路由库）。
 */
import { useEffect, useState } from 'react'
import LibraryPage from './pages/LibraryPage'
import ReaderPage from './pages/ReaderPage'
import { applySettingsToDocument, loadSettings } from './core/settings'

type View = { name: 'library' } | { name: 'reader'; bookId: string }

export default function App() {
  const [view, setView] = useState<View>({ name: 'library' })

  // 书库页也要应用主题与排版设置（阅读页打开时会再应用一次）
  useEffect(() => {
    applySettingsToDocument(loadSettings())
  }, [])

  if (view.name === 'reader') {
    return <ReaderPage bookId={view.bookId} onBack={() => setView({ name: 'library' })} />
  }
  return <LibraryPage onOpen={(bookId) => setView({ name: 'reader', bookId })} />
}
