import { useEffect, useRef } from 'react'

/**
 * 图片灯箱：在当前页面里放大看图，而不是弹一个新标签页。
 *
 * 交互取舍：
 *   * 点背景、点 ×、按 Esc 都关闭；**点图片本身不关** ——
 *     不然想仔细看时一碰就没了，而且右键「图片另存为」也会被误触干扰。
 *   * 打开时锁掉 body 滚动，否则滚轮会滚到底下那条消息列表上。
 *   * 原来的 <a href> 仍然保留在调用方：Cmd/Ctrl + 点击照样能开新标签页，
 *     右键菜单也没被吃掉（灯箱只是接管了普通左键）。
 *
 * @param {string|null} src - 要显示的图片地址；为空则不渲染任何东西
 * @param {string} alt
 * @param {() => void} onClose
 */
export default function ImageLightbox({ src, alt = '', onClose }) {
  // 用 ref 拿最新的回调：调用方几乎总是传内联箭头函数，
  // 直接写进依赖数组会让下面那个 effect 每次渲染都重跑一遍
  // （聊天页每敲一个字都会重渲染）。
  // ⚠️ 必须在 effect 里同步，不能在渲染期间直接赋值 —— 渲染期间改 ref 属于副作用。
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  useEffect(() => {
    if (!src) return
    const onKey = (e) => {
      if (e.key === 'Escape') closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [src])

  if (!src) return null

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="查看图片"
      onClick={() => closeRef.current()}
    >
      <button
        type="button"
        className="lightbox-close"
        aria-label="关闭"
        onClick={() => closeRef.current()}
      >
        ×
      </button>
      <img
        className="lightbox-img"
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}
