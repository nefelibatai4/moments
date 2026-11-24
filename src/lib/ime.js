import { useCallback, useEffect, useRef } from 'react'

/**
 * 输入法「组词 / 选字」时按下的回车不是发送，是上屏。
 *
 * 中文、日文、韩文输入法里，Enter 首先用于确认候选词；如果把它当成发送，
 * 用户会在字还没上屏时就把半截内容发出去。
 *
 * `useImeGuard` 要同时看三件事：
 *
 * 1. keydown 自己的 `isComposing` —— Chrome / Firefox 的顺序是
 *    keydown（此时仍在组词）→ compositionend；
 * 2. `keyCode === 229`（VK_PROCESSKEY）—— 旧 Safari / 某些输入法框架
 *    不会把 isComposing 带进 React 合成事件；
 * 3. compositionend 之后 50ms 内的回车 —— Safari 有时**先**派发
 *    compositionend、**再**派发确认回车（WebKit #165004）。那一刻
 *    isComposing 已经是 false，keyCode 也不一定是 229，只能靠这个
 *    极短的时间窗把「上屏回车」和「真的想发送」分开。比较用事件自带的
 *    timeStamp（不是 handler 执行时的 performance.now），并对差值取
 *    Math.abs —— Safari 可能把 keydown 的投递时间标得比 compositionend 略早。
 *
 * 用法：
 *
 *   const guardImeEnter = useImeGuard()
 *   onKeyDown={(e) => {
 *     if (guardImeEnter(e)) return          // 已经被 preventDefault
 *     if (e.key === 'Enter' && !e.shiftKey) {
 *       e.preventDefault()
 *       send()
 *     }
 *   }}
 *
 * guard 只处理 Enter，且**不处理 Shift+Enter**（换行要保留）。
 * 命中时它自己调用 preventDefault，所以单行输入框也不会再触发浏览器的
 * 隐式表单提交。
 */
export const IME_ENTER_GUARD_MS = 50

function nativeEventOf(e) {
  return e?.nativeEvent ?? e
}

/** 只认 Enter；keyCode 13 兜底某些拿不到 key 的旧内核 */
function isEnterEvent(e) {
  if (!e) return false
  const native = nativeEventOf(e)
  return (
    e.key === 'Enter' ||
    native.key === 'Enter' ||
    e.code === 'Enter' ||
    native.code === 'Enter' ||
    e.keyCode === 13 ||
    native.keyCode === 13
  )
}

/** 这个按键是不是输入法正在处理中的按键 */
function isImeKeyEvent(e) {
  if (!e) return false
  const native = nativeEventOf(e)
  return (
    e.nativeEvent?.isComposing === true ||
    native.isComposing === true ||
    e.isComposing === true ||
    e.keyCode === 229 ||
    native.keyCode === 229
  )
}

/**
 * 这个回车是不是输入法正在「组词 / 选字」时按下的。
 *
 * 保留这个纯函数给非 hook 场景（例如实验室里的小输入框）使用；
 * 聊天、评论这些有自定义 Enter 行为的输入框请用 useImeGuard。
 */
export function isImeComposing(e) {
  return isImeKeyEvent(e)
}

/**
 * 组件级输入法回车守卫。返回一个 `(event) => boolean`：
 * 命中输入法回车时返回 true 并 preventDefault，调用方直接 return。
 *
 * 监听挂在 document 的捕获阶段：输入框自己的 React onKeyDown 之前就能
 * 知道组词状态，不依赖每个输入框都手写 onCompositionStart/End。
 * 同一时间只可能有一个输入框在组词，所以多个组件各用一个 hook 也不会串。
 */
export function useImeGuard() {
  const composingRef = useRef(false)
  // compositionend 的时间戳。优先用事件自带 timeStamp：主线程卡住时
  // handler 实际执行时间可能晚很多，用 performance.now() 会把窗口算错。
  const endedAtRef = useRef(0)
  // 极少数内核的 timeStamp 是 0；这种情况下退回 handler 时间。
  const endedWallRef = useRef(0)

  useEffect(() => {
    const onCompositionStart = () => {
      composingRef.current = true
      endedAtRef.current = 0
      endedWallRef.current = 0
    }
    const onCompositionEnd = (event) => {
      composingRef.current = false
      const stamp = Number(event?.timeStamp)
      endedAtRef.current = Number.isFinite(stamp) && stamp > 0 ? stamp : 0
      endedWallRef.current = performance.now()
    }
    // 捕获阶段监听，确保先于 React 的 keydown 处理拿到 compositionend。
    document.addEventListener('compositionstart', onCompositionStart, true)
    document.addEventListener('compositionend', onCompositionEnd, true)
    return () => {
      document.removeEventListener('compositionstart', onCompositionStart, true)
      document.removeEventListener('compositionend', onCompositionEnd, true)
    }
  }, [])

  return useCallback((e) => {
    if (!isEnterEvent(e) || e.shiftKey) return false

    const composing = composingRef.current || isImeKeyEvent(e)
    const keyStamp = Number(nativeEventOf(e)?.timeStamp)
    const endedAt = endedAtRef.current
    // Math.abs：Safari 的 handler 投递顺序可能让 keydown 的 timeStamp
    // 比 compositionend 还早一点点，不能用单边差值。
    const justEnded = endedAt > 0 && Number.isFinite(keyStamp) && keyStamp > 0
      ? Math.abs(keyStamp - endedAt) <= IME_ENTER_GUARD_MS
      : endedWallRef.current > 0 && performance.now() - endedWallRef.current <= IME_ENTER_GUARD_MS

    if (!composing && !justEnded) return false

    if (typeof e.preventDefault === 'function') e.preventDefault()
    return true
  }, [])
}
