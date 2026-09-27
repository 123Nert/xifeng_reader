/**
 * pdfNav.ts — PDF 原版视图的页码 ↔ 字符偏移换算（纯函数，V6.2）。
 *
 * 原版位图按"PDF 页"翻，而进度 / 书签 / 目录 / 续读统一走 PageMap 的字符偏移
 * 坐标系（技术方案 §3.3）。两套体系靠导入时记录的 `pdfPageStarts`
 * （第 i 页文字在全文中的起始偏移）互转：
 *
 *   页号 → 偏移：直接查表（越界时钳到最后一页 / 0）
 *   偏移 → 页号：二分找"最后一个起点 <= offset"的页，即该偏移所在页
 *
 * 覆盖规则与文本分页一致 —— 页尾偏移仍属于本页（`start <= x < nextStart`）。
 */

/** 页码（0-based）与字符偏移的换算表；空表时所有换算退化为 0。 */
export class PdfPageNav {
  private readonly starts: number[]

  constructor(starts: number[]) {
    // 拷贝并保证单调不减：乱序/缺失（NaN）的输入不该让二分失控
    this.starts = starts
      .map((s) => (Number.isFinite(s) && s > 0 ? Math.floor(s) : 0))
      .sort((a, b) => a - b)
  }

  get pageCount(): number {
    return this.starts.length
  }

  /** 第 page 页（0-based）的起始字符偏移；越界钳到 [0, 末页]。 */
  offsetOfPage(page: number): number {
    if (this.starts.length === 0) return 0
    const i = Math.min(this.starts.length - 1, Math.max(0, Math.floor(page)))
    return this.starts[i]
  }

  /** 字符偏移所在的页号（0-based）；落在页尾时仍算本页。 */
  pageOfOffset(offset: number): number {
    const n = this.starts.length
    if (n === 0) return 0
    if (!Number.isFinite(offset) || offset <= 0) return 0
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** 某页在全文中的字符区间 [start, end)。末页 end 为传入的正文长度。 */
  rangeOfPage(page: number, totalChars: number): { start: number; end: number } {
    const i = Math.min(Math.max(0, Math.floor(page)), Math.max(0, this.starts.length - 1))
    const start = this.offsetOfPage(i)
    const end = i + 1 < this.starts.length ? this.starts[i + 1] : Math.max(start, totalChars)
    return { start, end }
  }
}
