/**
 * App.tsx — 入口：书库 / 阅读两个视图切换（技术方案：暂不引入路由库）。
 */
import { useEffect, useState } from 'react'
import LibraryPage from './pages/LibraryPage'
import ReaderPage from './pages/ReaderPage'
import StudyMaterialsPage from './pages/StudyMaterialsPage'
import { applySettingsToDocument, loadSettings } from './core/settings'

type View = { name: 'library' } | { name: 'study' } | { name: 'reader'; bookId: string; charIndex?: number }

export default function App() {
  const [view, setView] = useState<View>({ name: 'library' })

  // 书库页也要应用主题与排版设置（阅读页打开时会再应用一次）
  useEffect(() => {
    applySettingsToDocument(loadSettings())
  }, [])

  if (view.name === 'reader') {
    return <ReaderPage bookId={view.bookId} initialOffset={view.charIndex} onBack={() => setView({ name: 'library' })} />
  }
  if (view.name === 'study') return <StudyMaterialsPage onBack={() => setView({ name: 'library' })} onOpenReader={(bookId, charIndex) => setView({ name: 'reader', bookId, charIndex })} />
  return <LibraryPage onStudy={() => setView({ name: 'study' })} onOpen={(bookId) => setView({ name: 'reader', bookId })} />
}
