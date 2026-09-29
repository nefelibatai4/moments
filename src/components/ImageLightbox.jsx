import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** 把索引夹在 [0, total-1]：越界不报错，只是老老实实停在边界（不绕圈） */
function clampIndex(i, total) {
  const max = Math.max(total - 1, 0)
  const n = Number.isFinite(i) ? Math.trunc(i) : 0
  return Math.min(Math.max(n, 0), max)
}

/**
 * 图片灯箱：在当前页面里放大看图，而不是弹一个新标签页。
 *
 * 两种用法：
 *   * 单图：`<ImageLightbox src={url} onClose={…} />`（头像、聊天里的图）
 *   * 图集：`<ImageLightbox images={urls} index={n} onClose={…} />`
 *     —— 就是朋友圈那个体验：点第几张开第几张，然后左右逐张看，角上写「2 / 9」。
 *
 * ⚠️ 图集模式下调用方要**在打开时才挂载**它（关掉 = 卸载）：
 *   `index` 只当"先看第几张"的初值用，之后翻页是组件自己的状态。
 *   这样就不需要"外部索引变了要同步进来"的 effect —— 那种写法既多余，
 *   又会让 React 每翻一页多渲染一轮。
 *
 * 交互取舍：
 *   * 点背景、点 ×、按 Esc 都关闭；**点图片本身不关** ——
 *     不然想仔细看时一碰就没了，而且右键「图片另存为」也会被误触干扰。
 *     （微信是点图关，这里刻意不跟：手机上有 ×、有背景、还有滑动手势，够用了。）
 *   * 换图：桌面点左右箭头或 ←→，手机横滑；**到头就停住，不绕回另一头**
 *     （绕圈会让人以为"滑反了"）。竖滑不换图，留给"上下比一比"。
 *   * 打开时锁掉 body 滚动，否则滚轮会滚到底下那条消息列表上。
 *   * 原来的 <a href> 仍然保留在调用方：Cmd/Ctrl + 点击照样能开新标签页，
 *     右键菜单也没被吃掉（灯箱只是接管了普通左键）。
 *
 * @param {string|null} src - 单图模式：要显示的图片地址；为空则不渲染任何东西
 * @param {string[]} [images] - 图集模式：传了非空数组就按图集处理（优先于 src）
 * @param {number} [index=0] - 图集模式：先看第几张（从 0 开始）
 * @param {string} alt
 * @param {() => void} onClose
 */
export default function ImageLightbox({ src, images, index = 0, alt = '', onClose }) {
  const list = images?.length ? images : src ? [src] : []
  const total = list.length
  const [current, setCurrent] = useState(() => clampIndex(index, total))

  // 用 ref 拿最新的回调与下标：调用方几乎总是传内联箭头函数，
  // 直接写进依赖数组会让下面那些 effect 每次渲染都重跑一遍
  // （聊天页每敲一个字都会重渲染）。
  // ⚠️ 必须在 effect 里同步，不能在渲染期间直接赋值 —— 渲染期间改 ref 属于副作用。
  const closeRef = useRef(onClose)
  const currentRef = useRef(current)
  useEffect(() => {
    closeRef.current = onClose
    currentRef.current = current
  })

  const touchStartRef = useRef(null)
  // 横滑结束时，浏览器（尤其 Android）有时还会补发一次 click，
  // 那一下会落到背景上 → 刚滑完图就被关掉。记个时间戳把它吃掉。
  const lastSwipeRef = useRef(0)

  // 换到"当前这张 ± delta"（越界就停在边界）。
  // 读 currentRef 而不是 state，是为了让这个函数不随翻页变化 ——
  // 否则下面挂 keydown 的 effect 每翻一页都要重挂一次监听。
  // 顺带：连按两下箭头时，第二次点击发生在重渲染之前，只读 state 会少走一步。
  const step = useCallback((delta) => {
    const next = clampIndex(currentRef.current + delta, total)
    if (next === currentRef.current) return
    currentRef.current = next
    setCurrent(next)
  }, [total])

  // 预取左右两张：滑到下一张时是"已经下好了"，而不是盯着空白等
  const prevUrl = list[current - 1]
  const nextUrl = list[current + 1]
  useEffect(() => {
    for (const url of [prevUrl, nextUrl]) {
      if (!url) continue
      const im = new Image()
      im.src = url
    }
  }, [prevUrl, nextUrl])

  useEffect(() => {
    if (total === 0) return
    const onKey = (e) => {
      if (e.key === 'Escape') closeRef.current()
      else if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [total, step])

  if (total === 0) return null

  function onTouchStart(e) {
    const t = e.touches?.[0]
    if (!t) return
    touchStartRef.current = { x: t.clientX, y: t.clientY }
  }

  function onTouchEnd(e) {
    const start = touchStartRef.current
    touchStartRef.current = null
    const t = e.changedTouches?.[0]
    if (!start || !t) return
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    // 横滑才算换图：要够长（40px 起步，避免手抖），而且横向位移得压过纵向
    if (Math.abs(dx) < 40 || Math.abs(dx) <= Math.abs(dy)) return
    lastSwipeRef.current = Date.now()
    step(dx < 0 ? 1 : -1)
  }

  const showNav = total > 1

  // ⚠️ 用 portal 挂到 <body>，不要留在原地（2026-09-29 在真 iOS App 里量出来的坑）：
  //    灯箱原来是渲染在 `.moment-card` 里的，而手机上 `main` 是滚动容器
  //    （`overflow-y: auto` + `-webkit-overflow-scrolling: touch`）。
  //    WebKit 会给这样的滚动容器建自己的图层，于是**灯箱的 z-index: 100 只在 main 内部有效**，
  //    在外层它整块被排在 `.app-header`（底部 tab 栏）**下面** ——
  //    现象是：看大图时底栏反而亮着压在图上，角上的「2 / 3」计数被底栏挡住看不见。
  //    Chrome（桌面/安卓）不复现，所以本地那套 Playwright 断言全绿也照样漏了它。
  //    挂在 body 上就与任何祖先的图层规则无关了。
  const overlay = (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={showNav ? `查看图片（第 ${current + 1} 张，共 ${total} 张）` : '查看图片'}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onClick={() => {
        if (Date.now() - lastSwipeRef.current < 400) return
        closeRef.current()
      }}
    >
      <button
        type="button"
        className="lightbox-close"
        aria-label="关闭"
        onClick={() => closeRef.current()}
      >
        ×
      </button>

      {showNav && (
        <>
          <button
            type="button"
            className="lightbox-nav prev"
            aria-label="上一张"
            disabled={current === 0}
            onClick={(e) => { e.stopPropagation(); step(-1) }}
          >
            ‹
          </button>
          <button
            type="button"
            className="lightbox-nav next"
            aria-label="下一张"
            disabled={current === total - 1}
            onClick={(e) => { e.stopPropagation(); step(1) }}
          >
            ›
          </button>
          <p className="lightbox-counter">{current + 1} / {total}</p>
        </>
      )}

      <img
        className="lightbox-img"
        src={list[current]}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )

  return createPortal(overlay, document.body)
}
