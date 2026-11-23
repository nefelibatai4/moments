import { useLayoutEffect, useRef, useState } from 'react'

/**
 * 气泡内操作菜单（编辑 / 引用 / 撤回）。
 *
 * 位置不用固定坐标，也不浮到浏览器边缘：
 *   - DOM 上就渲染在 `.chat-bubble` 里面，所以天然跟着气泡走；
 *   - 横向贴着「远离头像」的一侧（自己：左内侧；对方：右内侧）；
 *   - 纵向按视口空间决定靠上还是靠下，靠近视口底部时向上翻；
 *   - 气泡装不下时只把气泡撑到刚好容下菜单（关闭即还原），因此菜单几何始终落在气泡矩形内。
 *
 * 这是 CSS Anchor Positioning 的等价 JS 实现（getBoundingClientRect + clamp），
 * 不依赖 Chrome 125+ 的 anchor-name，Safari / 插件 / Capacitor 同样可用。
 */

const EDGE = 4
// 预留一点呼吸空间：菜单下方不足这么多像素时视为「下方不够」，翻到气泡上部。
const FLIP_SAFE_GAP = 56

export default function BubbleMenu({ items, isMine, onClose, label = '消息操作' }) {
  const menuRef = useRef(null)
  const firstItemRef = useRef(null)
  const [placement, setPlacement] = useState('bottom')

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return undefined
    const wrap = menu.parentElement
    const bubble = menu.closest('.chat-bubble')
    if (!wrap || !bubble) return undefined

    const prevMinWidth = bubble.style.minWidth
    const prevMinHeight = bubble.style.minHeight

    const place = () => {
      const menuW = menu.offsetWidth
      const menuH = menu.offsetHeight
      if (!menuW || !menuH) return

      // 气泡太窄/太矮时临时撑开，保证菜单落在气泡矩形内；关闭时还原。
      const needW = menuW + EDGE * 2
      const needH = menuH + 22
      if (bubble.getBoundingClientRect().width < needW) bubble.style.minWidth = `${Math.ceil(needW)}px`
      if (bubble.getBoundingClientRect().height < needH) bubble.style.minHeight = `${Math.ceil(needH)}px`

      const wrapRect = wrap.getBoundingClientRect()
      const bubbleRect = bubble.getBoundingClientRect()

      // 远离头像那一侧：自己头像在右 → 菜单贴左；对方头像在左 → 菜单贴右。
      let left = isMine ? EDGE : wrapRect.width - menuW - EDGE
      left = Math.max(EDGE, Math.min(left, wrapRect.width - menuW - EDGE))

      const spaceBelow = window.innerHeight - bubbleRect.bottom
      const spaceAbove = bubbleRect.top
      const flip = spaceBelow < menuH + EDGE + FLIP_SAFE_GAP && spaceAbove > spaceBelow
      const preferTop = flip ? EDGE : wrapRect.height - menuH - EDGE

      // 先限制在气泡内，再尽量限制在视口内；气泡本身被视口裁掉时以气泡内为准。
      const insideMin = EDGE
      const insideMax = Math.max(insideMin, wrapRect.height - menuH - EDGE)
      const viewMin = Math.max(insideMin, -wrapRect.top + EDGE)
      const viewMax = Math.min(insideMax, window.innerHeight - wrapRect.top - menuH - EDGE)
      const top = viewMax >= viewMin
        ? Math.max(viewMin, Math.min(preferTop, viewMax))
        : Math.max(insideMin, Math.min(preferTop, insideMax))

      menu.style.left = `${Math.round(left)}px`
      menu.style.top = `${Math.round(top)}px`
      menu.style.visibility = 'visible'
      setPlacement(flip ? 'top' : 'bottom')
    }

    place()
    const onViewportChange = () => place()
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)

    return () => {
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
      bubble.style.minWidth = prevMinWidth
      bubble.style.minHeight = prevMinHeight
    }
  }, [isMine])

  useLayoutEffect(() => {
    firstItemRef.current?.focus({ preventScroll: true })
  }, [])

  return (
    <div
      className="chat-msg-menu"
      role="menu"
      aria-label={label}
      data-placement={placement}
      data-anchor="bubble"
      ref={menuRef}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, index) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className={item.danger ? 'danger' : undefined}
          ref={index === 0 ? firstItemRef : undefined}
          onClick={() => {
            item.onSelect?.()
            onClose(false)
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
