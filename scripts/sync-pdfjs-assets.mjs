/**
 * sync-pdfjs-assets.mjs — 把 pdf.js 的可选静态资源铺到 public/pdfjs/（V6.0）。
 *
 * 为什么需要这一步：pdf.js 的 CMap / 标准字体不打包进 JS，而是运行期按 URL 取。
 * 中文 PDF 大量使用「Type0 + 预定义 CMap」（如 /GBK-EUC-H）且字体不带 ToUnicode，
 * 缺了 cmaps/*.bcmap 就会抽出零字符（被误判为扫描版）；标准 14 号字体同理。
 *
 * 设计取舍：
 * - 资源放 public/pdfjs/ 而非 node_modules 直链 —— 构建产物自包含，可离线、可任意静态托管；
 * - 该目录已 gitignore，由本脚本从 node_modules 复现（repo 里不出现 1.5MB 二进制）；
 * - **不复制 wasm/**：那些模块只服务于 canvas 渲染与图片解码（ICC/JBIG2/JPEG2000），
 *   本项目只做文本抽取，用不到；省下约 900KB。
 *
 * 由 package.json 的 predev / prebuild / pretest 钩子自动调用，也可手动 `node scripts/...`。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const destRoot = join(projectRoot, 'public', 'pdfjs')

/** 需要随应用分发的 pdf.js 资源目录。 */
const DIRS = ['cmaps', 'standard_fonts']

function resolvePdfjsRoot() {
  const require = createRequire(import.meta.url)
  try {
    return dirname(require.resolve('pdfjs-dist/package.json'))
  } catch {
    return null
  }
}

const pdfjsRoot = resolvePdfjsRoot()
if (!pdfjsRoot) {
  // 依赖尚未安装时不要打断 dev/build 的启动流程
  console.warn('[pdfjs-assets] 未找到 pdfjs-dist，已跳过（先执行 npm install）')
  process.exit(0)
}

// 每次全量重建，避免旧版本残留的 cmap 与新版本混用
rmSync(destRoot, { recursive: true, force: true })
mkdirSync(destRoot, { recursive: true })

let copied = 0
for (const dir of DIRS) {
  const src = join(pdfjsRoot, dir)
  if (!existsSync(src)) {
    console.warn(`[pdfjs-assets] 缺少 ${dir}/，已跳过`)
    continue
  }
  cpSync(src, join(destRoot, dir), { recursive: true })
  copied += readdirSync(join(destRoot, dir)).length
}

if (copied === 0) {
  console.warn('[pdfjs-assets] 没有可复制的资源，PDF 中文抽取可能失败')
  process.exit(1)
}

const size = (() => {
  let total = 0
  const walk = (p) => {
    for (const name of readdirSync(p)) {
      const full = join(p, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else total += st.size
    }
  }
  walk(destRoot)
  return (total / 1024).toFixed(0)
})()

console.log(`[pdfjs-assets] 已铺 ${copied} 个文件（${size} KB）到 public/pdfjs/`)
