/**
 * dismiss.ts 单元测试：翻译浮卡"移开即收起"的判定边界。
 *
 * 这些用例都是从真实操作里反推出来的：刚点完译指针在卡外、手抖、
 * 手从工具栏移向"复制译文"按钮、停在卡内读译文……错一条都会让用户觉得卡片乱消失。
 */
import { describe, expect, it } from 'vitest'
import {
  ARM_DELAY_MS,
  HOVER_SETTLE_MS,
  isSignificantMove,
  MOVE_EPSILON_PX,
  shouldAutoDismissHover,
} from './dismiss'

const T0 = 1_000_000

/** 默认构造一个"该收起"的场景，再按需覆盖单个条件。 */
const base = {
  shownAt: T0,
  now: T0 + ARM_DELAY_MS + HOVER_SETTLE_MS + 100,
  lastMoveAt: T0 + ARM_DELAY_MS,
  pointerInside: false,
}

describe('dismiss: 显著移动', () => {
  it('位移达到阈值算移动', () => {
    expect(isSignificantMove({ x: 0, y: 0 }, { x: MOVE_EPSILON_PX, y: 0 })).toBe(true)
    expect(isSignificantMove({ x: 10, y: 10 }, { x: 10, y: 10 + MOVE_EPSILON_PX })).toBe(true)
  })

  it('手抖/漂移不算移动', () => {
    expect(isSignificantMove({ x: 100, y: 100 }, { x: 103, y: 102 })).toBe(false)
    expect(isSignificantMove({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(false)
  })

  it('斜向位移按直线距离判定（3-4-5）', () => {
    expect(isSignificantMove({ x: 0, y: 0 }, { x: 9, y: 12 })).toBe(true) // 距离 15
  })
})

describe('dismiss: 移开即收起', () => {
  it('标准场景：指针移开并停下 → 收起', () => {
    expect(shouldAutoDismissHover(base)).toBe(true)
  })

  it('指针停在浮卡内 → 永不收起（正在读译文/点按钮）', () => {
    expect(shouldAutoDismissHover({ ...base, pointerInside: true })).toBe(false)
  })

  it('刚出现就判定 → 不收起（避开"指针本来就在卡外"的误判）', () => {
    expect(shouldAutoDismissHover({ ...base, now: T0 + 100, lastMoveAt: T0 + 50 })).toBe(false)
    expect(shouldAutoDismissHover({ ...base, now: T0 + ARM_DELAY_MS - 1 })).toBe(false)
  })

  it('指针始终没动过 → 不收起（用户在专心读译文）', () => {
    expect(shouldAutoDismissHover({ ...base, lastMoveAt: null })).toBe(false)
  })

  it('移动刚发生、还没停下 → 不收起（手正在移向"复制译文"）', () => {
    expect(
      shouldAutoDismissHover({ ...base, lastMoveAt: base.now - (HOVER_SETTLE_MS - 1) }),
    ).toBe(false)
    expect(shouldAutoDismissHover({ ...base, lastMoveAt: base.now - HOVER_SETTLE_MS })).toBe(true)
  })

  it('移动发生在浮卡出现之前 → 不算"从卡片移开"', () => {
    expect(shouldAutoDismissHover({ ...base, lastMoveAt: T0 - 1000 })).toBe(false)
  })

  it('恰好停在卡外的临界：位移刚好达阈值、停顿刚好达阈值 → 收起', () => {
    expect(
      shouldAutoDismissHover({
        shownAt: T0,
        now: T0 + ARM_DELAY_MS + HOVER_SETTLE_MS,
        lastMoveAt: T0 + ARM_DELAY_MS,
        pointerInside: isSignificantMove({ x: 0, y: 0 }, { x: MOVE_EPSILON_PX, y: 0 }) ? false : true,
      }),
    ).toBe(true)
  })
})
