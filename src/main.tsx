import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/theme.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// PWA（V2.1）：生产构建注册 Service Worker；开发模式不注册以免干扰 HMR
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((err) => {
      console.warn('Service Worker 注册失败', err)
    })
  })
}
