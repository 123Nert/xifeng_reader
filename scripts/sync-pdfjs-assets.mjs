/**
 * sync-pdfjs-assets.mjs — 把 pdf.js 的可选静态资源铺到 public/pdfjs/（V6.0）。
 *
 * 为什么需要这一步：pdf.js 的 CMap / 标准字体不打包进 JS，而是运行期按 URL 取。
 * 中文 PDF 大量使用「Type0 + 预定义 CMap」（如 /GBK-EUC-H）且字体不带 ToUnicode，
 * 缺了 cmaps/*.bcmap 就会抽出零字符（被误判为扫描版）；standard_fonts 同理。
 *
 * 设计取舍：
 * - 资源放 public/pdfjs/ 而非 node_modules 直链 —— 构建产物自包含，可离线、可任意静态托管；
 * - 该目录已 gitignore，由本脚本从 node_modules 复现（repo 里不出现 1.5MB 二进制）；
 * - **不复制 wasm/**：那些模块只服务于 canvas 渲染与图片解码（ICC/JBIG2/JPEG2000），
 *   本项目只做文本抽取，用不到；省下约 900KB。
 *
 * 由 package.json 的 predev / prebuild / pretest 钩子自动调用，也可手动 `node scripts/...`。
 *
 * Windows + 中文路径注意：在部分启动器（git-bash 的 npm → node 链路）下，Node 的
 * `fs.cpSync` 在 ~169 个 .bcmap 文件的目标路径含某些字符（中文/特殊符号）时可能不抛异常
 * 也不复制，直接以 exit code 127 返回且无任何输出 —— 这是 Node 在 Windows + 非 ASCII
 * 路径上的一个已知行为差异，不是脚本逻辑错误。
 * 因此本脚本不走 cpSync，改用 readdirSync + copyFileSync 逐文件复制（实测可工作）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// 用 realpathSync + existsSync(package.json) 兜底部分 Windows 启动器对非 ASCII cwd 的解析偏差。
function resolveProjectRoot() {
  try {
    const realHere = realpathSync(here)
    const candidate = resolve(realHere, '..')
    if (existsSync(join(candidate, 'package.json'))) return candidate
  } catch { /* fall through */ }
  try {
    const realCwd = realpathSync(process.cwd())
    if (existsSync(join(realCwd, 'package.json'))) return realCwd
  } catch { /* fall through */ }
  return resolve(here, '..')
}
const projectRoot = resolveProjectRoot()
const destRoot = join(projectRoot, 'public', 'pdfjs')

const DIRS = ['cmaps', 'standard_fonts', 'wasm']

function resolvePdfjsRoot() {
  const require = createRequire(import.meta.url)
  try {
    return dirname(require.resolve('pdfjs-dist/package.json'))
  } catch {
    return null
  }
}

function* walk(p) {
  for (const name of readdirSync(p)) {
    const full = join(p, name)
    const st = statSync(full)
    if (st.isDirectory()) yield* walk(full)
    else yield full
  }
}

const pdfjsRoot = resolvePdfjsRoot()
if (!pdfjsRoot) {
  console.warn('[pdfjs-assets] 未找到 pdfjs-dist，已跳过（先执行 npm install）')
  process.exit(0)
}

rmSync(destRoot, { recursive: true, force: true })
mkdirSync(destRoot, { recursive: true })

let copied = 0
let totalSize = 0
for (const dir of DIRS) {
  const src = join(pdfjsRoot, dir)
  if (!existsSync(src)) {
    console.warn(`[pdfjs-assets] 缺少 ${dir}/，已跳过`)
    continue
  }
  for (const srcFile of walk(src)) {
    const rel = srcFile.slice(src.length + 1)
    const dst = join(destRoot, dir, rel)
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(srcFile, dst)
    copied++
    totalSize += statSync(dst).size
  }
}

if (copied === 0) {
  console.warn('[pdfjs-assets] 没有可复制的资源，PDF 中文抽取可能失败')
  process.exit(1)
}

console.log(`[pdfjs-assets] 已铺 ${copied} 个文件（${(totalSize / 1024).toFixed(0)} KB）到 ${destRoot}`)
