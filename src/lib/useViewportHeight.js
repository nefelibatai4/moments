import { useEffect } from 'react'

/**
 * 把"应用外壳"的高度钉在**可见视口**上（CSS 变量 `--app-h`）。
 *
 * ── 为什么不能只用 CSS 的 100dvh/100vh（使用者 2026-09-24 的实测反馈）
 * 手机上底栏改用"外壳 + 内部滚动"之后，**四个 tab 全部浮起来**，而且浮起的高度
 * 跟之前只在短页面上出现的高度一模一样 —— 说明 iOS 报告的视口高度比真实可见区域
 * 高了一个固定值，CSS 视口单位在启动时拿到的是这个偏大的值。
 * （本机 Chromium 量不出来：它的 innerHeight 与可见区域永远一致。）
 *
 * `visualViewport` 是浏览器给的"可见视口"（键盘弹起、工具栏收起都会更新），
 * 所以这里用它来定外壳高度，并在 resize / 滚动 / 转屏 / 回到前台时重算 ——
 * 相当于替浏览器把这件事做对。
 */
export function useViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport
    let frame = 0

    const apply = () => {
      const h = vv?.height || window.innerHeight
      if (!h) return
      document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`)
    }

    // 合并同一帧内的多次触发（resize + scroll 常常一起来）
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(apply)
    }

    apply()
    // 再补两次：iOS 上首帧的视口高度常常还没稳定下来
    const t1 = setTimeout(apply, 120)
    const t2 = setTimeout(apply, 600)

    window.addEventListener('resize', schedule)
    window.addEventListener('orientationchange', schedule)
    window.addEventListener('pageshow', schedule)
    vv?.addEventListener('resize', schedule)
    vv?.addEventListener('scroll', schedule)
    document.addEventListener('visibilitychange', schedule)

    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('orientationchange', schedule)
      window.removeEventListener('pageshow', schedule)
      vv?.removeEventListener('resize', schedule)
      vv?.removeEventListener('scroll', schedule)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [])
}
