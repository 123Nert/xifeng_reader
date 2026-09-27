/**
 * bookCovers.ts — 书籍封面生成的编排（V6.3）。
 *
 * 封面 = 这本书的"第一页"，与在阅读页打开它看到的第一眼一致：
 * - PDF：用 pdfFiles 里的原件渲染第 1 页（老记录退回库里存的页位图）；
 * - EPUB：书里自带封面优先（归一化到封面尺寸）；
 * - TXT / MD / HTML：把正文开头画成纸页（core/cover.ts）。
 *
 * 两条入口：
 * - `buildCoverFromImport`：导入时手上就有 buffer / 正文，直接生成，省一次读库；
 * - `buildBookCover`：进书库时为**老书**补齐（读库取原件或正文）。
 *
 * 一切失败都返回 null —— 封面是可选增强，绝不能挡住导入或让书消失。
 */
import { COVER_WIDTH, drawDataUrlCover, drawTextCover } from './cover'
import { getBook, getPdfFile, listPdfPages, type BookRecord } from './bookRepository'
import type { ImportResult } from './importers/types'

/** PDF 首页 → 封面尺寸位图。动态引入 pdf.js，避免非 PDF 用户加载解析器。 */
async function coverFromPdfBytes(bytes: ArrayBuffer): Promise<string | null> {
  const { renderPdfFirstPage } = await import('./pdfOriginal')
  const page = await renderPdfFirstPage(bytes, COVER_WIDTH)
  if (!page) return null
  return await drawDataUrlCover(page.dataUrl)
}

/** 导入时生成封面：手上已有原文件字节与正文，不用再读一次库。 */
export async function buildCoverFromImport(
  result: ImportResult,
  buffer: ArrayBuffer,
  content: string,
): Promise<string | null> {
  try {
    if (result.format === 'pdf') {
      if (buffer.byteLength > 0) {
        const cover = await coverFromPdfBytes(buffer)
        if (cover) return cover
      }
      // 没有原件（理论上不会走到）时退回封面文字摘要，总比纯色块强
      return drawTextCover(content || result.title)
    }
    if (result.cover) {
      const normalized = await drawDataUrlCover(result.cover)
      if (normalized) return normalized
    }
    return drawTextCover(content || result.title)
  } catch (e) {
    console.error('[cover] 导入期封面生成失败:', e instanceof Error ? e.message : String(e))
    return null
  }
}

/** 进书库时为老书补齐封面：从库里读原件（PDF）或正文（文本类）。 */
export async function buildBookCover(bookId: string): Promise<string | null> {
  try {
    const book: BookRecord | undefined = await getBook(bookId)
    if (!book) return null

    if (book.format === 'pdf') {
      const bytes = await getPdfFile(bookId)
      if (bytes) {
        const cover = await coverFromPdfBytes(bytes)
        if (cover) return cover
      }
      // 老记录（V6.1）：位图已按页存在库里，第 1 页就是封面
      const pages = await listPdfPages(bookId)
      if (pages[0]?.dataUrl) {
        const cover = await drawDataUrlCover(pages[0].dataUrl)
        if (cover) return cover
      }
      // V6.2 之前导入的文字版 PDF：库里既没有原件也没有位图（当时只存了文字），
      // 无法还原原页 —— 退回"按第一段文字排版"的封面，总比纯色块强
      return drawTextCover(book.content || book.title)
    }

    if (book.cover) {
      const normalized = await drawDataUrlCover(book.cover)
      if (normalized) return normalized
    }
    return drawTextCover(book.content || book.title)
  } catch (e) {
    console.error('[cover] 封面补齐失败:', bookId, e instanceof Error ? e.message : String(e))
    return null
  }
}
