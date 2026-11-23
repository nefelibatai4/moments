import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 气泡操作菜单的触发与生命周期（私聊 / 群聊共用）。
 *
 * 触发只有两种：桌面右键、触屏长按约 500ms。
 * 不保留 hover 才出现的 ⋯ 按钮 —— 触屏没有 hover，那个入口在手机上等于不存在
 * （PITFALLS #42），而且使用者要的是小红书那种「按住气泡就出菜单」。
 *
 * 菜单本体由 <BubbleMenu> 渲染在气泡内部；这个 hook 只负责：
 *   - 右键 / 长按识别（移动超过 10px 视为滚动，取消）
 *   - 触屏长按后吞掉随之而来的 click，避免顺手点开图片/贴纸
 *   - Esc / 点别处关闭，并把焦点还给触发的气泡
 */

const LONG_PRESS_MS = 500
const MOVE_TOLERANCE = 10

export default function useBubbleMenu() {
  const [menu, setMenu] = useState(null)
  const menuRef = useRef(null)
  const pressTimerRef = useRef(null)
  const pressStartRef = useRef(null)
  const suppressClickRef = useRef(false)
  const suppressTimerRef = useRef(null)
  // 延迟归还焦点时用来判断“这期间是不是又打开了另一个菜单”
  const focusTokenRef = useRef(0)

  const clearPress = useCallback(() => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current)
      pressTimerRef.current = null
    }
    pressStartRef.current = null
  }, [])

  const closeMenu = useCallback((restoreFocus = true, deferFocus = false) => {
    const current = menuRef.current
    if (!current) return
    menuRef.current = null
    setMenu(null)
    if (!restoreFocus) return
    const anchor = current.anchor
    const focusAnchor = () => {
      if (!anchor?.isConnected) return
      try { anchor.focus({ preventScroll: true }) } catch { anchor.focus() }
    }
    // 点空白时浏览器的默认动作会把焦点移到 body，等这一拍过去再还回去；
    // 点输入框/按钮时则不动，别把用户刚点到的控件抢走。
    if (deferFocus) {
      const token = focusTokenRef.current
      setTimeout(() => { if (focusTokenRef.current === token) focusAnchor() }, 0)
    } else focusAnchor()
  }, [])

  const openMenu = useCallback((anchor, id) => {
    if (!anchor) return
    focusTokenRef.current += 1
    // 气泡默认不在 Tab 序里；用 -1 让它能被程序聚焦（关闭时归还焦点），
    // 又不增加一整页的 Tab 停靠点。
    if (!anchor.hasAttribute('tabindex')) anchor.setAttribute('tabindex', '-1')
    const next = { id, anchor }
    menuRef.current = next
    setMenu(next)
  }, [])

  useEffect(() => () => {
    clearTimeout(pressTimerRef.current)
    clearTimeout(suppressTimerRef.current)
  }, [])

  // 长按：只有真正的手指/触控笔才算。鼠标按住不抢系统右键行为。
  const onPointerDown = useCallback((e, id) => {
    if (e.target.closest?.('.chat-msg-menu')) return
    clearPress()
    if (e.pointerType === 'mouse' || e.button !== 0) return
    const anchor = e.currentTarget
    const startX = e.clientX
    const startY = e.clientY
    pressStartRef.current = { x: startX, y: startY }
    pressTimerRef.current = setTimeout(() => {
      pressTimerRef.current = null
      pressStartRef.current = null
      // 长按成功后浏览器还会补一个 click；吞掉它，否则会顺手点开图片/贴纸。
      suppressClickRef.current = true
      clearTimeout(suppressTimerRef.current)
      suppressTimerRef.current = setTimeout(() => { suppressClickRef.current = false }, 900)
      openMenu(anchor, id)
    }, LONG_PRESS_MS)
  }, [clearPress, openMenu])

  const onPointerMove = useCallback((e) => {
    const start = pressStartRef.current
    if (!start || !pressTimerRef.current) return
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_TOLERANCE) clearPress()
  }, [clearPress])

  const onPointerUp = useCallback(() => { clearPress() }, [clearPress])
  const onPointerCancel = useCallback(() => { clearPress() }, [clearPress])
  const onPointerLeave = useCallback(() => { clearPress() }, [clearPress])

  const onContextMenu = useCallback((e, id) => {
    // 右键一定要吃掉浏览器原生菜单；触屏长按触发的 contextmenu 也走这里。
    e.preventDefault()
    clearPress()
    if (e.target.closest?.('.chat-msg-menu')) return
    openMenu(e.currentTarget, id)
  }, [clearPress, openMenu])

  const onClickCapture = useCallback((e) => {
    if (!suppressClickRef.current) return
    // 长按抬起时的第一个 click 一律吞掉 —— 包括正好落在刚弹出的菜单项上的那种：
    // 菜单是在手指还按着的时候出现的，抬手的 click 不该被当成“点了编辑/撤回”。
    suppressClickRef.current = false
    e.preventDefault()
    e.stopPropagation()
  }, [])

  // 点空白 / Esc 关闭。用 pointerdown 而不是 click：长按是「按下 500ms 后打开」，
  // 如果听 click，手指抬起补的那个 click 会立刻把刚打开的菜单关掉。
  useEffect(() => {
    if (!menu) return undefined
    const onDocPointerDown = (e) => {
      if (e.target.closest?.('.chat-msg-menu')) return
      const focusable = e.target.closest?.('input, textarea, select, button, a[href], [contenteditable="true"], [tabindex]')
      closeMenu(!focusable, !focusable)
    }
    const onDocClick = (e) => {
      // 兜底：程序化 click / 键盘触发的 click 也要能关。
      // 排除气泡本身，避免触屏长按抬起时的合成 click 把菜单立刻关掉。
      if (e.target.closest?.('.chat-msg-menu')) return
      if (menu.anchor?.contains(e.target)) return
      closeMenu(true)
    }
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeMenu(true)
    }
    document.addEventListener('pointerdown', onDocPointerDown, true)
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true)
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [menu, closeMenu])

  const bubbleMenuProps = useCallback((id) => ({
    'data-bubble-menu': '1',
    onPointerDown: (e) => onPointerDown(e, id),
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave,
    onContextMenu: (e) => onContextMenu(e, id),
    onClickCapture,
  }), [onContextMenu, onClickCapture, onPointerCancel, onPointerDown, onPointerLeave, onPointerMove, onPointerUp])

  return { openId: menu?.id ?? null, bubbleMenuProps, closeMenu }
}
