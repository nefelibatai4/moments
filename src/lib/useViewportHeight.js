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
 *
 * ⚠️ 2026-09-30 追加：iOS 在键盘弹起时**还会把页面整体滚一段**（把被聚焦的输入框露出来），
 * 而外壳已经自己收缩过了 → 输入框会被顶到屏幕最上面，且收键盘后滚动位置不回滚（底栏浮空）。
 * 所以手机外壳模式下每次重算都顺手把文档滚动按回 0（详见 apply() 里的注释）。
 */
export function useViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport
    // ⚠️ 这行曾经被我删掉过（大改时误删），后果是 effect 一进来就 `root is not defined`：
    //    **整个 hook 静默失效**（--app-h 永远不设置、监听器也不挂），
    //    而页面看起来"还行"——因为 CSS 里 `height: var(--app-h, 100dvh)` 有 100dvh 兜底。
    //    是"在真机/模拟器里读 `--app-h` 读到空"才把它揪出来的（见 docs/MOBILE-VERIFY.md）。
    const root = document.documentElement
    let frame = 0
    let poll = 0

    // 手机外壳 = 窄屏 + 非插件面板（桌面布局与 data-surface 面板都不吃这套）
    const isMobileShell = () =>
      !root.hasAttribute('data-surface') && window.matchMedia('(max-width: 600px)').matches

    const apply = () => {
      const h = vv?.height || window.innerHeight
      if (!h) return
      root.style.setProperty('--app-h', `${Math.round(h)}px`)
      // ⚠️ 光有外壳收缩还不够（使用者 2026-09-30 真机实测）：
      //    iOS 在输入框获得焦点时会**把整个页面往下滚**一段（把输入框"露"出来）——
      //    在私聊页量到的正是 `scrollY = 397 = innerHeight(874) - visualViewport(477)`。
      //    我们的外壳本来就自己收缩到键盘上方了，页面再滚一次的结果就是
      //    **输入框飞到屏幕顶上**；而且收起键盘后**这个滚动位置不会自己回去**，
      //    于是下一屏看到的就是底栏浮空、下面空一条。
      //    手机外壳模式下页面本身永远不该滚动（滚动都发生在 `main` 内部），所以按回 0。
      //    只在手机外壳（≤600px 且非插件面板）生效 —— 桌面布局是要靠文档滚动的。
      if (isMobileShell() && window.scrollY !== 0) window.scrollTo(0, 0)
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
