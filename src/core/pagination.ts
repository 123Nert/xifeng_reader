/**
 * pagination.ts — 分页引擎（技术方案 §3.3，核心纯逻辑）。
 *
 * 数据模型：全文在内存中就是一个字符串；"一页"是字符区间 [start, end)。
 * 渲染层每次只把当前页的子串放进 DOM，页界按需计算——这就是大文件
 * "分块/懒加载"要求的落点。
 *
 * 页界是"局部可推导"的，不依赖全量预分页：
 *   - 下一页起点 = fitFrom(当前起点)：从当前起点实测能放进一页的最大字符数；
 *   - 上一页起点 = prevStart(当前起点)：向前walker找到"恰好以当前起点为页尾"的页。
 * 因此翻页 / 跳转 / 续读都只做常数次实测，百万字长文打开与翻页同样流畅。
 *
 * 可测试性：Measurer 接口隔离了 DOM 布局依赖（jsdom 不做布局），
 * 单测注入按行填充规则模拟的假 Measurer 即可覆盖全部核心逻辑。
 */

/** 与 DOM 相关的测量能力，由 UI 层注入实现。 */
export interface Measurer {
  /** 估算的每页容量（字符数），只用于定位起步与防退化，允许不精确。 */
  estimateCapacity(): number
  /** 从 start 开始的 n 个字符按当前样式排版后，能否放进一页。 */
  fits(start: number, n: number): boolean
}

export interface Page {
  start: number
  end: number
}

export class PageMap {
  private readonly text: string;
  private readonly measurer: Measurer;
  private curStart = 0;
  /** 当前页终点缓存，惰性重算（字号/行距变更后由 reflow 刷新）。 */
  private curEnd = 0;

  constructor(text: string, measurer: Measurer) {
    this.text = text;
    this.measurer = measurer;
    this.curEnd = this.fitFrom(0);
  }

  get totalChars(): number {
    return this.text.length;
  }

  get current(): Page {
    return { start: this.curStart, end: this.curEnd };
  }

  get atLastPage(): boolean {
    return this.curEnd >= this.totalChars;
  }

  get atFirstPage(): boolean {
    return this.curStart <= 0;
  }

  /** 当前页的文本切片。 */
  pageText(): string {
    return this.text.slice(this.curStart, this.curEnd);
  }

  /**
   * 求从 start 开始的一页的终点：最大的 end 使 [start, end) 放得进一页。
   * 以估算容量起步指数扩张找上界，再二分收敛，单次约十几到二十次测量。
   * 页高连一个字符都放不下时至少推进 1，保证调用方不会死循环。
   */
  fitFrom(start: number): number {
    const remaining = this.totalChars - start;
    if (remaining <= 0) return start;
    if (!this.measurer.fits(start, 1)) return start + 1;

    const cap = Math.max(1, Math.floor(this.measurer.estimateCapacity()));
    let lo = 1;
    let hi = Math.min(remaining, Math.max(2, cap));
    while (hi < remaining && this.measurer.fits(start, hi)) {
      lo = hi;
      hi = Math.min(remaining, hi * 2);
    }
    if (hi >= remaining && this.measurer.fits(start, remaining)) {
      return this.totalChars;
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (this.measurer.fits(start, mid)) lo = mid;
      else hi = mid;
    }
    return start + lo;
  }

  /**
   * 求上一页起点：返回 p < end 使 [p, end) 恰好放得进一页。
   * 从 max(0, end - C) 起步：若从 p 能排到 end 之后，说明 [p, end) 是其
   * 子区间必然放得下；否则前进到 fitFrom(p) 再试。页长约为容量 C，
   * 因此通常一两步收敛，且结果 p ∈ [end - C, end)，页长不超过 C。
   */
  prevStart(end: number): number {
    if (end <= 0) return 0;
    const cap = Math.max(1, Math.floor(this.measurer.estimateCapacity()));
    let p = Math.max(0, end - cap);
    let e = this.fitFrom(p);
    while (e < end) {
      p = e;
      e = this.fitFrom(p);
    }
    return p;
  }

  /** 翻到下一页；返回 false 表示已在最后一页。 */
  goNext(): boolean {
    if (this.atLastPage) return false;
    this.curStart = this.curEnd;
    this.curEnd = this.fitFrom(this.curStart);
    return true;
  }

  /** 翻到上一页；返回 false 表示已在第一页。上一页页尾严格等于当前页起点。 */
  goPrev(): boolean {
    if (this.atFirstPage) return false;
    const end = this.curStart;
    this.curStart = this.prevStart(end);
    this.curEnd = end;
    return true;
  }

  /**
   * 跳转到以 charIndex 为起点的页（进度条拖动、续读共用）。
   * 直接以目标字符为新页的起点并按新链重排——页界本就局部可推导，
   * 这样落点即所拖位置，续读零回退，且反复开关书不会产生位置漂移
   * （技术方案 §3.3 的"MVP 简化：跳转后丢弃其后的缓存页，从新页界继续"）。
   */
  jumpTo(charIndex: number): Page {
    const total = this.totalChars;
    if (total === 0) {
      this.curStart = 0;
      this.curEnd = 0;
      return this.current;
    }
    const t = Math.min(Math.max(charIndex, 0), total - 1);
    if (t >= this.curStart && t < this.curEnd) return this.current;
    this.curStart = t;
    this.curEnd = this.fitFrom(t);
    return this.current;
  }

  /**
   * 锚定重排：字号/行距变更、窗口尺寸变化后调用。
   * 以"当前页首字符偏移"为锚点，按新度量重算当前页界，阅读位置不丢。
   */
  reflow(): Page {
    this.curEnd = this.fitFrom(this.curStart);
    return this.current;
  }
}
