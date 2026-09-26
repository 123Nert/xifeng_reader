/**
 * epub.ts — EPUB 解析（V5.0，零依赖）。
 *
 * 流程（方案 §3）：ZIP 目录 → container.xml → OPF（manifest/spine/metadata）
 * → 目录（nav 文档 或 NCX）→ 按 spine 顺序抽取各章文本 → 拼接单文本流并记录章节偏移。
 *
 * 设计要点：图片不进入正文（保持字符偏移分页模型），仅提取封面；
 * 单章损坏跳过并记入 warnings，不因局部问题拒绝整本导入。
 */
import { htmlToText } from './html'
import { ImportError, type ImportProgress, type ImportResult, type TocEntryLite } from './types'
import { readZipDirectory, readZipEntry, readZipText, type ZipEntry } from './zip'

/** 把归档内相对路径规范化为绝对路径（处理 ../ 与 ./）。 */
export function resolvePath(base: string, href: string): string {
  if (/^[a-z]+:/i.test(href)) return href // 绝对 URL 不支持
  const cleanHref = href.split('#')[0]
  const baseDir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : ''
  const parts = (baseDir + cleanHref).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/** 解码 URI 转义（%20 等），用于本地文件名匹配。 */
function decodeUriPath(p: string): string {
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

interface ManifestItem {
  id: string
  href: string
  mediaType: string
  properties: string
}

/** 解析 OPF：manifest / spine / metadata。 */
export function parseOpf(opf: string): {
  manifest: ManifestItem[]
  spine: string[]
  title: string | null
  author: string | null
  language: string | null
  coverId: string | null
} {
  const manifest: ManifestItem[] = []
  const itemRe = /<item\b([^>]*)\/?>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(opf))) {
    const attrs = m[1]
    const get = (name: string): string => {
      const r = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs)
      return r ? unescapeXml(r[1]) : ''
    }
    const id = get('id')
    const href = get('href')
    if (id && href) {
      manifest.push({
        id,
        href,
        mediaType: get('media-type').toLowerCase(),
        properties: get('properties').toLowerCase(),
      })
    }
  }

  const spine: string[] = []
  const spineBlock = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(opf)?.[1] ?? ''
  const refRe = /<itemref\b([^>]*)\/?>/gi
  while ((m = refRe.exec(spineBlock))) {
    const idref = /idref\s*=\s*["']([^"']*)["']/i.exec(m[1])?.[1]
    if (idref) spine.push(unescapeXml(idref))
  }

  const title = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1]
  const author = /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opf)?.[1]
  const language = /<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i.exec(opf)?.[1]
  const coverId = /<meta\b[^>]*name\s*=\s*["']cover["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(
    opf,
  )?.[1]

  return {
    manifest,
    spine,
    title: title ? unescapeXml(title).trim() : null,
    author: author ? unescapeXml(author).trim() : null,
    language: language ? unescapeXml(language).trim() : null,
    coverId: coverId ? unescapeXml(coverId) : null,
  }
}

/**
 * 解析导航文档（EPUB3 nav 或 NCX），返回 「章节文件路径 → 标题」映射。
 * 结构千变万化，这里只要 title 与 href 的配对，用宽松匹配。
 */
export function parseNav(navHtml: string, basePath: string): Map<string, string> {
  const map = new Map<string, string>()
  const linkRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(navHtml))) {
    const href = unescapeXml(m[1])
    // 去掉内联标签后取文本作为标题
    const title = unescapeXml(m[2].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
    if (!title) continue
    const path = resolvePath(basePath, href)
    if (!map.has(path)) map.set(path, title)
  }
  return map
}

/** 解析 NCX（EPUB2 目录）。 */
export function parseNcx(ncx: string, basePath: string): Map<string, string> {
  const map = new Map<string, string>()
  const pointRe = /<navPoint\b[\s\S]*?<\/navPoint>/gi
  const points = ncx.match(pointRe) ?? []
  for (const p of points) {
    const label = /<navLabel\b[\s\S]*?<text[^>]*>([\s\S]*?)<\/text>/i.exec(p)?.[1]
    const src = /<content\b[^>]*src\s*=\s*["']([^"']+)["']/i.exec(p)?.[1]
    if (!label || !src) continue
    const title = unescapeXml(label).replace(/\s+/g, ' ').trim()
    if (!title) continue
    const path = resolvePath(basePath, unescapeXml(src))
    if (!map.has(path)) map.set(path, title)
  }
  return map
}

function guessMimeFromName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.xhtml') || lower.endsWith('.html') || lower.endsWith('.htm')) return 'application/xhtml+xml'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.webp')) return 'image/webp'
  return ''
}

/** 找到归档里最匹配给定名字的条目（容忍 %20 与路径前缀差异）。 */
function findEntry(entries: ZipEntry[], path: string): ZipEntry | undefined {
  const decoded = decodeUriPath(path)
  return (
    entries.find((e) => e.name === path) ??
    entries.find((e) => e.name === decoded) ??
    entries.find((e) => decodeUriPath(e.name) === decoded) ??
    entries.find((e) => e.name.toLowerCase() === decoded.toLowerCase())
  )
}

/** 主入口：解析 EPUB 为统一导入结果。 */
export async function importEpub(
  buffer: ArrayBuffer,
  fallbackTitle: string,
  onProgress?: ImportProgress,
): Promise<ImportResult> {
  const warnings: string[] = []
  onProgress?.({ phase: '读取归档' })

  let entries: ZipEntry[]
  try {
    entries = readZipDirectory(buffer)
  } catch (e) {
    throw new ImportError(
      e instanceof Error ? e.message : 'EPUB 归档解析失败',
      '文件可能已损坏，或不是标准 EPUB；可尝试用其他来源重新下载',
    )
  }

  // 1) container.xml → OPF 路径
  const container = await readZipText(buffer, entries, 'META-INF/container.xml')
  let opfPath: string | null = null
  if (container) {
    const m = /<rootfile\b[^>]*full-path\s*=\s*["']([^"']+)["']/i.exec(container)
    if (m) opfPath = decodeUriPath(unescapeXml(m[1]))
  }
  if (!opfPath) {
    // 兜底：取第一个 .opf
    opfPath = entries.find((e) => e.name.toLowerCase().endsWith('.opf'))?.name ?? null
  }
  if (!opfPath) {
    throw new ImportError('EPUB 里找不到书籍清单（OPF）', '文件可能不完整，请重新下载')
  }

  const opf = await readZipText(buffer, entries, opfPath)
  if (!opf) throw new ImportError(`无法读取书籍清单：${opfPath}`)

  const { manifest, spine, title, author, language, coverId } = parseOpf(opf)
  const byId = new Map(manifest.map((it) => [it.id, it]))

  // 2) 目录：nav（EPUB3） 或 ncx（EPUB2）
  onProgress?.({ phase: '解析目录' })
  let navMap = new Map<string, string>()
  const navItem = manifest.find((it) => it.properties.includes('nav'))
  if (navItem) {
    const navPath = resolvePath(opfPath, navItem.href)
    const navHtml = await readZipText(buffer, entries, navPath)
    if (navHtml) navMap = parseNav(navHtml, navPath)
  }
  if (navMap.size === 0) {
    const ncxItem =
      manifest.find((it) => it.mediaType === 'application/x-dtbncx+xml') ??
      manifest.find((it) => it.href.toLowerCase().endsWith('.ncx'))
    if (ncxItem) {
      const ncxPath = resolvePath(opfPath, ncxItem.href)
      const ncx = await readZipText(buffer, entries, ncxPath)
      if (ncx) navMap = parseNcx(ncx, ncxPath)
    }
  }
  if (navMap.size === 0) {
    warnings.push('未找到目录文件，章节将按正文标题或"第 N 章"命名')
  }

  // 3) 按 spine 顺序抽取正文
  const chapterPaths: string[] = []
  for (const idref of spine) {
    const item = byId.get(idref)
    if (!item) continue
    if (!/xhtml|html/.test(item.mediaType || guessMimeFromName(item.href))) continue
    const path = resolvePath(opfPath, item.href)
    if (findEntry(entries, path)) chapterPaths.push(path)
  }
  if (chapterPaths.length === 0) {
    // 兜底：manifest 里所有 xhtml
    for (const it of manifest) {
      if (/xhtml|html/.test(it.mediaType)) {
        const path = resolvePath(opfPath, it.href)
        if (findEntry(entries, path)) chapterPaths.push(path)
      }
    }
    if (chapterPaths.length > 0) warnings.push('未找到阅读顺序（spine），已按清单顺序导入')
  }
  if (chapterPaths.length === 0) {
    throw new ImportError('EPUB 里没有可读的正文内容')
  }

  // 4) 拼接：每章插入标题行并记录偏移
  const parts: string[] = []
  const tocEntries: TocEntryLite[] = []
  let cursor = 0
  const pushLine = (line: string) => {
    if (cursor > 0) {
      parts.push('\n\n')
      cursor += 2
    }
    parts.push(line)
    cursor += line.length
  }

  const chapterTitles: string[] = []
  for (let i = 0; i < chapterPaths.length; i++) {
    const path = chapterPaths[i]
    onProgress?.({ phase: '解析章节', current: i + 1, total: chapterPaths.length })
    const entry = findEntry(entries, path)
    let raw = ''
    try {
      const bytes = await readZipEntry(buffer, entry!)
      raw = new TextDecoder('utf-8').decode(bytes)
    } catch (e) {
      warnings.push(`第 ${i + 1} 章读取失败，已跳过：${e instanceof Error ? e.message : ''}`)
      continue
    }
    const { text, headings } = htmlToText(raw)
    if (!text) {
      warnings.push(`第 ${i + 1} 章内容为空，已跳过`)
      continue
    }
    // 标题优先级：导航目录 > 正文首个标题 > "第 N 章"
    const navTitle = navMap.get(path) ?? navMap.get(decodeUriPath(path))
    const heading = headings[0]
    const titleText = navTitle ?? heading ?? `第 ${i + 1} 章`

    // 若正文已以标题开头，不重复插入
    const bodyText = titleText && text.startsWith(titleText) ? text : `${titleText}\n${text}`
    // pushLine 会先补 "\n\n" 分隔符，标题的实际写入位置在其之后
    const startIndex = cursor > 0 ? cursor + 2 : 0
    pushLine(bodyText)
    tocEntries.push({ title: titleText, charIndex: startIndex })
    chapterTitles.push(titleText)
  }

  if (parts.length === 0) throw new ImportError('EPUB 正文解析结果为空')

  // 5) 封面提取
  onProgress?.({ phase: '提取封面' })
  let cover: string | undefined
  const coverCandidates: ManifestItem[] = []
  if (coverId && byId.get(coverId)) coverCandidates.push(byId.get(coverId)!)
  const propCover = manifest.find((it) => it.properties.includes('cover-image'))
  if (propCover) coverCandidates.push(propCover)
  for (const it of manifest) {
    if (it.mediaType.startsWith('image/')) coverCandidates.push(it)
  }
  for (const cand of coverCandidates) {
    const path = resolvePath(opfPath, cand.href)
    const entry = findEntry(entries, path)
    if (!entry) continue
    try {
      const bytes = await readZipEntry(buffer, entry)
      if (bytes.length > 2_000_000) continue // 超大图跳过（>2MB）
      const mime = cand.mediaType || guessMimeFromName(entry.name) || 'image/jpeg'
      cover = `data:${mime};base64,${bytesToBase64(bytes)}`
      break
    } catch {
      // 忽略单张封面失败
    }
  }

  return {
    title: title || fallbackTitle,
    text: parts.join(''),
    format: 'epub',
    cover,
    tocEntries,
    author: author ?? undefined,
    language: language ?? undefined,
    warnings,
  }
}

/** Uint8Array → base64（分块避免栈溢出）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
