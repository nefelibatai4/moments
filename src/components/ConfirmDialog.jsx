import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * 项目风格的危险操作确认弹层（替代原生 window.confirm）。
 *
 * 视觉：Raycast 深色体系 —— 页面色遮罩 + `--bg-card` 弹层 + 16px 圆角 +
 * `--popup-shadow`/`--border-standard` 的分层深度；危险按钮用 `--accent-red`
 * 半透明底，不新增硬编码颜色（见 DESIGN.md 的 Level 2/5 与圆角规范）。
 *
 * 交互（与灯箱 Modal 的焦点规范一致，见 ImageLightbox.jsx）：
 *   * 打开时焦点移入弹层，默认落在「取消」上（危险操作不默认聚焦确认键）；
 *   * Tab / Shift+Tab 只在弹层内循环，程序化跑到外面也会被拉回；
 *   * Esc、点遮罩、点「取消」都关闭，关闭后焦点回到触发元素
 *     （触发元素若已随菜单卸载，则由 `returnFocus` 给出合理的回归点）；
 *   * `pending`（删除中）：确认键变成「删除中…」，两个键都禁用，
 *     Esc / 遮罩暂时不响应，避免请求已发出却"看起来取消了"。
 *
 * 组件按需挂载：调用方用 `{open && <ConfirmDialog … />}`，关闭即卸载。
 *
 * @param {string} title - 标题（必填）
 * @param {string} [description] - 补充说明
 * @param {string} [confirmLabel='删除'] - 确认按钮文案
 * @param {string} [pendingLabel='删除中…'] - 进行中的确认按钮文案
 * @param {string} [cancelLabel='取消'] - 取消按钮文案
 * @param {boolean} [pending=false] - 请求进行中
 * @param {() => void} onConfirm
 * @param {() => void} onCancel
 * @param {() => (HTMLElement|null)} [returnFocus] - 关闭后焦点的兜底回归点
 */
export default function ConfirmDialog({
  title,
  description,
  confirmLabel = '删除',
  pendingLabel = '删除中…',
  cancelLabel = '取消',
  pending = false,
  onConfirm,
  onCancel,
  returnFocus,
}) {
  const titleId = useId()
  const descId = useId()
  const overlayRef = useRef(null)
  const cancelRef = useRef(null)

  // 用 ref 读最新的回调/状态：effect 只在挂载/卸载时跑一次，
  // 不因为父组件重渲染（或内联箭头函数换身份）而重挂焦点逻辑。
  const pendingRef = useRef(pending)
  const onCancelRef = useRef(onCancel)
  const returnFocusRef = useRef(returnFocus)
  useEffect(() => {
    pendingRef.current = pending
    onCancelRef.current = onCancel
    returnFocusRef.current = returnFocus
  })

  useEffect(() => {
    const node = overlayRef.current
    if (!node) return undefined

    // 打开前谁有焦点，关闭后就还给谁。菜单里的「删除」在打开弹层时已被卸载，
    // 这时用调用方给的 returnFocus() 兜底（MomentCard 指向卡片的 ⋯ 触发器）。
    const previous = document.activeElement
    const restoreTarget = () => {
      if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected) return previous
      const fallback = returnFocusRef.current?.()
      return fallback instanceof HTMLElement ? fallback : null
    }

    const focusables = () => Array.from(node.querySelectorAll(FOCUSABLE))
      .filter((el) => el instanceof HTMLElement && el.getClientRects().length > 0)
    const focusFirst = () => {
      const first = focusables()[0]
      ;(first || node).focus({ preventScroll: true })
    }

    // 默认焦点给「取消」：删除是危险操作，回车不该误删。
    ;(cancelRef.current || node).focus({ preventScroll: true })

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        // 删除请求已发出：此时关闭只会造成"取消了但数据没了"的错觉。
        // 保持弹层与"删除中…"可见，等请求落定。
        if (pendingRef.current) return
        onCancelRef.current?.()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        // pending 时两个按钮都禁用：焦点留在弹层上，别跑到背后页面。
        e.preventDefault()
        node.focus({ preventScroll: true })
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const activeIndex = items.indexOf(document.activeElement)
      if (activeIndex === -1) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus({ preventScroll: true })
        return
      }
      if (e.shiftKey && activeIndex === 0) {
        e.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!e.shiftKey && activeIndex === items.length - 1) {
        e.preventDefault()
        first.focus({ preventScroll: true })
      }
    }

    const onFocusIn = (e) => {
      if (!node.contains(e.target)) focusFirst()
    }

    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocusIn)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocusIn)
      document.body.style.overflow = prevOverflow
      // 卡片可能已随删除成功被卸载：只有还连在文档里的元素才值得聚焦。
      restoreTarget()?.focus({ preventScroll: true })
    }
  }, [])

  const overlay = (
    <div
      ref={overlayRef}
      className="confirm-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      tabIndex={-1}
      onClick={(e) => {
        // 只有点到遮罩本身才关闭；点弹层内容不关（避免误触）。
        if (e.target !== e.currentTarget || pendingRef.current) return
        onCancelRef.current?.()
      }}
    >
      <div className="confirm-panel">
        <h2 className="confirm-title" id={titleId}>{title}</h2>
        {description && <p className="confirm-desc" id={descId}>{description}</p>}
        <div className="confirm-actions">
          <button
            ref={cancelRef}
            type="button"
            className="confirm-cancel"
            onClick={() => onCancelRef.current?.()}
            disabled={pending}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="confirm-danger"
            onClick={() => onConfirm?.()}
            disabled={pending}
          >
            {pending ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}
