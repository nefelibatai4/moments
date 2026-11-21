import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * 时间线滚动位置记忆 / 恢复。
 *
 * ── 为什么需要它
 * 手机外壳（≤600、非插件 surface）把滚动交给 `main`，桌面/插件则滚文档；
 * 路由切换时 Timeline 被卸载，私聊外壳还会把窗口按回 0（见 ChatWorkspace）。
 * 两件事叠在一起，用户从动态深处点进私聊、再点「动态」回来就只能落在顶部。
 *
 * ── 边界
 * * 只记时间线，不碰聊天消息列表的滚动（聊天贴底/翻历史逻辑原样保留）。
 * * 内存记忆，不写 localStorage/sessionStorage：整页刷新/重新打开仍从顶部开始，
 *   只有 SPA 内的「离开 → 回来」才恢复。
 * * 不修改 useViewportHeight：它在手机外壳里按回的是 `window.scrollY`，
 *   而手机时间线的滚动发生在 `main` 内部，两者互不干扰。
 * * 关键计算都按「当前真正的滚动容器」来：手机 `main`，其余 `window`。
 *   所以同一个 hook 在桌面（文档滚动）和插件面板（iframe 内文档滚动）也成立。
 */

// 只有这些 overflow 值才代表 main 自己滚（手机外壳）。插件/桌面 main 是 visible。
const SCROLL_OVERFLOWS = new Set(['auto', 'scroll', 'overlay'])

// 单个 SPA 会话里的时间线位置。按 userId 区分，避免换账号后串位置。
let remembered = null

function getScrollContainer() {
  const main = document.querySelector('.app-container > main')
  if (!main) return null
  const { overflowY } = window.getComputedStyle(main)
  return SCROLL_OVERFLOWS.has(overflowY) ? main : null
}

function readTop() {
  const el = getScrollContainer()
  return el ? el.scrollTop : window.scrollY
}

function maxTop() {
  const el = getScrollContainer()
  if (el) return Math.max(0, el.scrollHeight - el.clientHeight)
  const doc = document.scrollingElement || document.documentElement
  return Math.max(0, doc.scrollHeight - window.innerHeight)
}

function jumpTo(top) {
  const el = getScrollContainer()
  if (el) el.scrollTop = top
  else window.scrollTo(0, top)
}

function save(userId, top) {
  if (!userId || !Number.isFinite(top)) return
  remembered = { userId, top }
}

/**
 * @param {object} opts
 * @param {string|undefined} opts.userId 当前账号（换账号不串记忆）
 * @param {boolean} opts.ready 时间线内容已经渲染（至少有一条，首屏骨架/空态不算）
 * @param {{current: HTMLElement|null}} opts.timelineRef 时间线根节点，用于监听内容高度变化
 */
export function useTimelineScrollRestore({ userId, ready, timelineRef }) {
  // 每个 Timeline 实例只取一次记忆；StrictMode 的额外 effect 循环不会重复消费。
  const targetRef = useRef(null)
  const initializedForRef = useRef(null)
  useLayoutEffect(() => {
    if (!userId || initializedForRef.current === userId) return
    initializedForRef.current = userId
    targetRef.current =
      remembered && remembered.userId === userId ? remembered.top : null
  }, [userId])

  // 用户自己动了一下（点、滚轮、触摸、键盘）就立刻交还控制权，
  // 避免"恢复动画"和用户滚动打架；同时把当前位置记下来。
  useEffect(() => {
    if (!userId) return undefined
    const takeOver = () => {
      targetRef.current = null
      save(userId, readTop())
    }
    const options = { capture: true, passive: true }
    window.addEventListener('pointerdown', takeOver, options)
    window.addEventListener('touchstart', takeOver, options)
    window.addEventListener('wheel', takeOver, options)
    window.addEventListener('keydown', takeOver, options)
    return () => {
      window.removeEventListener('pointerdown', takeOver, options)
      window.removeEventListener('touchstart', takeOver, options)
      window.removeEventListener('wheel', takeOver, options)
      window.removeEventListener('keydown', takeOver, options)
    }
  }, [userId])

  // 持续记录滚动位置。恢复期间（targetRef 非空）不写，否则首帧的 0
  // 或浏览器钳制后的临时值会把待恢复的目标冲掉。
  useLayoutEffect(() => {
    if (!userId) return undefined
    const onScroll = () => {
      if (targetRef.current != null) return
      save(userId, readTop())
    }
    // window 与 main 都挂：手机滚 main、桌面/插件滚文档；运行中跨 600px 断点时
    // 也不至于因为"挂错容器"而漏记（读取时仍按当前生效的容器算）。
    const main = document.querySelector('.app-container > main')
    const nodes = main ? [window, main] : [window]
    for (const node of nodes) node.addEventListener('scroll', onScroll, { passive: true })
    // 切到后台/锁屏前也存一次，回来被系统重建时还有可恢复的位置
    const onHide = () => onScroll()
    document.addEventListener('visibilitychange', onHide)
    return () => {
      for (const node of nodes) node.removeEventListener('scroll', onScroll)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [userId])

  // 等内容出现后再恢复，并持续跟一段时间：
  //   * 首帧可能只有骨架/空态，此时 scrollHeight 不够，贸然跳会被浏览器钳到 0；
  //   * 图片、字体、键盘收起带来的高度变化会让可滚动距离变大，需要再补一次。
  // 目标在 3 秒内一直够不到（例如内容真的变短了）就停在当前能到的最深处。
  useLayoutEffect(() => {
    if (!userId || !ready || targetRef.current == null) return undefined
    const started = Date.now()
    let cancelled = false
    let raf = 0
    let timer = 0
    let observer = null

    const finish = () => {
      if (cancelled) return
      targetRef.current = null
      save(userId, readTop())
      if (observer) {
        observer.disconnect()
        observer = null
      }
      clearTimeout(timer)
    }

    const attempt = () => {
      if (cancelled || targetRef.current == null) return
      const target = targetRef.current
      const max = maxTop()
      jumpTo(Math.min(target, max))
      // 目标位置已经能到达 → 成功；否则等内容继续长高再试
      if (max >= target - 1) {
        finish()
        return
      }
      if (Date.now() - started > 3000) {
        finish()
        return
      }
      timer = setTimeout(() => {
        raf = requestAnimationFrame(attempt)
      }, 80)
    }

    raf = requestAnimationFrame(attempt)

    if (typeof ResizeObserver === 'function' && timelineRef.current) {
      observer = new ResizeObserver(() => {
        if (targetRef.current == null) return
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(attempt)
      })
      observer.observe(timelineRef.current)
      const el = getScrollContainer()
      if (el) observer.observe(el)   // 键盘收起 → main 高度变化 → 再恢复一次
    }

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      clearTimeout(timer)
      observer?.disconnect()
    }
  }, [ready, userId, timelineRef])
}
