import { useLayoutEffect, useRef, useState } from 'react'

/**
 * 气泡内操作菜单（编辑 / 引用 / 撤回）。
 *
 * 位置不用固定坐标，也不浮到浏览器边缘：
 *   - DOM 上就渲染在 `.chat-bubble` 里面，所以天然跟着气泡走；
 *   - 横向贴着「远离头像」的一侧（自己：左内侧；对方：右内侧）；
 *     气泡太窄放不下时改贴另一侧，让菜单向消息区空白处展开；
 *   - 纵向按消息区/视口空间决定靠上还是靠下，靠近底部时向上翻；
 *   - **不修改气泡的宽高**：菜单是绝对定位的浮层，可以溢出气泡，但会被限制在
 *     消息区可视范围内（`.chat-messages`），因此不会撑大数据、也不会把气泡顶变形。
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

    // 菜单是气泡里的绝对定位浮层，但“可见范围”是整块消息区（含上下滚动裁切）。
    const list = menu.closest('.chat-messages') ?? document.documentElement

    const place = () => {
      const menuW = menu.offsetWidth
      const menuH = menu.offsetHeight
      if (!menuW || !menuH) return

      const wrapRect = wrap.getBoundingClientRect()
      const bubbleRect = bubble.getBoundingClientRect()
      const listRect = list.getBoundingClientRect()
      const viewportW = Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth)
      const viewportH = Math.min(window.innerHeight, document.documentElement.clientHeight || window.innerHeight)

      // 可放置的矩形 = 消息区 ∩ 视口，再留出 EDGE 的呼吸空间。
      const minLeft = Math.max(listRect.left, 0) + EDGE
      const maxLeft = Math.max(minLeft, Math.min(listRect.right, viewportW) - EDGE - menuW)
      const minTop = Math.max(listRect.top, 0) + EDGE
      const maxTop = Math.max(minTop, Math.min(listRect.bottom, viewportH) - EDGE - menuH)

      // 远离头像那一侧：自己头像在右 → 菜单贴左；对方头像在左 → 菜单贴右。
      // 气泡太窄时改贴另一侧，让菜单朝消息区空白处展开，避免压到头像/被裁掉。
      let leftAbs = isMine
        ? wrapRect.left + EDGE
        : wrapRect.right - EDGE - menuW
      if (isMine && leftAbs > maxLeft) {
        leftAbs = wrapRect.right - EDGE - menuW
      } else if (!isMine && leftAbs < minLeft) {
        leftAbs = wrapRect.left + EDGE
      }
      leftAbs = Math.max(minLeft, Math.min(leftAbs, maxLeft))

      const spaceBelow = Math.min(listRect.bottom, viewportH) - bubbleRect.bottom
      const spaceAbove = bubbleRect.top - Math.max(listRect.top, 0)
      const flip = spaceBelow < menuH + EDGE + FLIP_SAFE_GAP && spaceAbove > spaceBelow
      let topAbs = flip ? wrapRect.top + EDGE : wrapRect.bottom - menuH - EDGE
      topAbs = Math.max(minTop, Math.min(topAbs, maxTop))

      // 坐标换算成相对 .chat-msg-menu-wrap（= 气泡 padding box）的值。
      menu.style.left = `${Math.round(leftAbs - wrapRect.left)}px`
      menu.style.top = `${Math.round(topAbs - wrapRect.top)}px`
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
