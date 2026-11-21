import { useEffect } from 'react'

/**
 * 手机键盘弹起时，把消息列表钉回"最新一条"。
 *
 * 私聊（ChatThread）与群聊（GroupThread）必须用同一套行为：
 * 视口变化 / 输入框聚焦之前记下"原本是否在底部"；变化后若原本在底部才回到底部，
 * 正在翻历史时**不动**（否则会打断回看）。
 *
 * ⚠️ `enabled` 只在窄屏/手机形态为 true。桌面 ≥1024 三栏的右栏由 flex 固定高度，
 *    窗口 resize 不代表键盘弹起；套用手机 hack 会在拖动窗口时把会话强行拉到底。
 */
export function usePinLatestOnViewport({ enabled, listRef, onPin, rerunKey }) {
  useEffect(() => {
    if (!enabled) return undefined
    const el = listRef.current
    if (!el) return undefined

    let wasNearBottom = true
    const timers = new Set()
    let raf = null

    const nearBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < 80
    const remember = () => { wasNearBottom = nearBottom() }
    const pinIfNeeded = () => {
      if (!wasNearBottom) return
      if (onPin) onPin()
      else el.scrollTop = el.scrollHeight
    }
    const later = (fn, ms) => {
      const id = setTimeout(() => { timers.delete(id); fn() }, ms)
      timers.add(id)
    }
    const handleViewportChange = () => {
      remember()
      // 键盘动画有几百毫秒，iOS 可能只发一次中间态 → 多补几帧
      raf = requestAnimationFrame(pinIfNeeded)
      later(pinIfNeeded, 120)
      later(pinIfNeeded, 400)
    }

    remember()
    window.visualViewport?.addEventListener('resize', handleViewportChange)
    window.visualViewport?.addEventListener('scroll', handleViewportChange)
    window.addEventListener('resize', handleViewportChange)
    document.addEventListener('focusin', handleViewportChange, true)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      for (const id of timers) clearTimeout(id)
      timers.clear()
      window.visualViewport?.removeEventListener('resize', handleViewportChange)
      window.visualViewport?.removeEventListener('scroll', handleViewportChange)
      window.removeEventListener('resize', handleViewportChange)
      document.removeEventListener('focusin', handleViewportChange, true)
    }
    // rerunKey 通常传 loading：消息区要等数据到了才渲染，挂载那一刻 ref 还是 null。
  }, [enabled, listRef, onPin, rerunKey])
}
