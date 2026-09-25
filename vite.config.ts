/// <reference types="vitest" />
import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 相对路径产物，任意静态子路径可直接部署
  base: './',
  server: {
    // 书架数据（IndexedDB）按"域名+端口"隔离，固定端口保证续读数据稳定；
    // 端口被占用时直接报错退出，避免悄悄换端口后打开一个空书架
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: 'node',
    // demo/ 是早期归档的原生 JS 示例（CommonJS），不属于本工程测试
    exclude: [...configDefaults.exclude, 'demo/**'],
  },
})
