/// <reference types="vitest" />
import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 相对路径产物，任意静态子路径可直接部署
  base: './',
  test: {
    environment: 'node',
    // demo/ 是早期归档的原生 JS 示例（CommonJS），不属于本工程测试
    exclude: [...configDefaults.exclude, 'demo/**'],
  },
})
