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
    let poll = 0

    const apply = () => {
      const h = vv?.height || window.innerHeight
      if (!h) return
      document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`)
    }

    // 合并同一帧内的多次触发（resize + scroll 常常一起来），并在之后**持续跟 2 秒**再定稿。
    // ⚠️ 为什么必须"跟一段"：iOS（尤其「添加到主屏幕」的独立网页模式）在**收起键盘**时
    //    有时只补发一个中间态高度、最后一次 resize 干脆不发 —— 外壳就永远短一截，
    //    表现是底栏浮空、下面空出一条（使用者 2026-09-30 真机实测：差值正好约一段键盘高度）。
    //    100ms × 20 的轮询就是为了兜住"事件缺失"，代价可忽略。
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(apply)
      clearInterval(poll)
      let n = 0
      poll = setInterval(() => {
        apply()
        if (++n >= 20) clearInterval(poll)
      }, 100)
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
    // 键盘收起时不保证有 resize —— 焦点变化也重算（capture 才能听到所有输入框）
    document.addEventListener('focusin', schedule, true)
    document.addEventListener('focusout', schedule, true)

    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
      cancelAnimationFrame(frame)
      clearInterval(poll)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('orientationchange', schedule)
      window.removeEventListener('pageshow', schedule)
      vv?.removeEventListener('resize', schedule)
      vv?.removeEventListener('scroll', schedule)
      document.removeEventListener('visibilitychange', schedule)
      document.removeEventListener('focusin', schedule, true)
      document.removeEventListener('focusout', schedule, true)
    }
  }, [])
}
