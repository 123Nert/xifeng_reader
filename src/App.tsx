/**
 * App.tsx — 入口：书库 / 阅读两个视图切换（技术方案：暂不引入路由库）。
 */
import { useState } from 'react'
import LibraryPage from './pages/LibraryPage'
import ReaderPage from './pages/ReaderPage'

type View = { name: 'library' } | { name: 'reader'; bookId: string }

export default function App() {
  const [view, setView] = useState<View>({ name: 'library' })

  if (view.name === 'reader') {
    return <ReaderPage bookId={view.bookId} onBack={() => setView({ name: 'library' })} />
  }
  return <LibraryPage onOpen={(bookId) => setView({ name: 'reader', bookId })} />
}
