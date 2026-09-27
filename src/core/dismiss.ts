/**
 * dismiss.ts — 浮层"移开即收起"的判定（V6.5，纯函数）。
 *
 * 翻译浮卡只有 ✕ / Esc 两条关闭路径时，读英文书频繁查词会很烦：
 * 查完一个词要抬手去点那个小叉。所以加一条"鼠标移到别处就自动收起"。
 *
 * 但"移开就消失"不能做成字面意思 —— 点完「译」的一瞬间指针本来就停在卡外
 * （它停在刚收起的浮动工具栏位置上），而且想点「复制译文」时手要跨过卡外区域。
 * 因此判定由三个条件共同决定（缺一不可）：
 *
 *   1. 浮卡出现已满 ARM_DELAY_MS —— 避开"刚点完译、指针还在卡外"的误判；
 *   2. 指针**真的移动过**（累计位移 ≥ MOVE_EPSILON_PX）—— 手抖不算"我要走了"；
 *   3. 指针停在卡外且**停下** HOVER_SETTLE_MS —— 移动途中不消失，停下来才收。
 *
 * 幂等、无副作用，可单测；DOM 侧只负责提供"指针在哪、何时动的、是否在卡内"。
 */

/** 浮卡出现后多久才接受"移开"判定（毫秒）。 */
export const ARM_DELAY_MS = 600
/** 指针累计位移达到多少像素才算"真的移动了"。 */
export const MOVE_EPSILON_PX = 12
/** 指针停在浮卡外多久才收起（毫秒）。 */
export const HOVER_SETTLE_MS = 500
/** 轮询间隔：只需比 HOVER_SETTLE_MS 小一个量级，240ms 的误差无感。 */
export const HOVER_POLL_MS = 120

export interface Point {
  x: number
  y: number
}

/** 从 from 移到 to 是否算"显著移动"（手抖/漂移不算）。 */
export function isSignificantMove(from: Point, to: Point, epsilon = MOVE_EPSILON_PX): boolean {
  const dx = to.x - from.x
  const dy = to.y - from.y
  return Math.hypot(dx, dy) >= epsilon
}

export interface HoverDismissInput {
  /** 浮卡出现的时刻（ms，Date.now()） */
  shownAt: number
  /** 当前时刻（ms） */
  now: number
  /** 浮卡出现后**最后一次显著移动**的时刻；null = 出现后指针一直没动 */
  lastMoveAt: number | null
  /** 指针此刻是否停在浮卡内部 */
  pointerInside: boolean
}

/**
 * 是否应该因为"鼠标移到别处并停下"而收起浮卡。
 * 指针停在浮卡内（含按钮）永远返回 false —— 正在读译文/点按钮，不能收。
 */
export function shouldAutoDismissHover(input: HoverDismissInput): boolean {
  if (input.pointerInside) return false
  if (input.now - input.shownAt < ARM_DELAY_MS) return false
  // 没动过 → 用户在专心读译文，不动它
  if (input.lastMoveAt == null) return false
  // 移动发生在浮卡出现之前，不算"从卡片移开"
  if (input.lastMoveAt < input.shownAt) return false
  return input.now - input.lastMoveAt >= HOVER_SETTLE_MS
}
