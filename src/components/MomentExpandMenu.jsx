import { useState } from 'react'

/**
 * 卡片右上角的 ⋯ 菜单。
 *
 * ⚠️ 2026-09-30 起「赞 / 评论」**搬到了卡片底部操作条**（微博那种信息流形态，见 MomentCard
 * 的 `.moment-actions`），这里只留不能放在操作条上的操作：匿名评论 / 编辑 / 删除。
 * 点赞逻辑也随之搬到 MomentCard（同一处实现，避免两套）。
 */
export default function MomentExpandMenu({ onRequestAnonymousComment, isOwner, onEdit, onDelete, deleting }) {
  const [menuOpen, setMenuOpen] = useState(false)

  function handleAnonymousComment() {
    setMenuOpen(false)
    onRequestAnonymousComment()
  }

  function handleDelete() {
    setMenuOpen(false)
    onDelete()
  }

  function handleEdit() {
    setMenuOpen(false)
    onEdit()
  }

  return (
    <div className="expand-menu">
      <button
        type="button"
        className="expand-trigger"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="展开操作"
      >
        ···
      </button>
      {menuOpen && (
        <div className="expand-popup">
          <button type="button" className="anon" onClick={handleAnonymousComment}>匿名评论</button>
          {isOwner && (
            <button type="button" onClick={handleEdit}>编辑</button>
          )}
          {isOwner && (
            <button type="button" className="danger" onClick={handleDelete} disabled={deleting}>
              {deleting ? '删除中…' : '删除'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}