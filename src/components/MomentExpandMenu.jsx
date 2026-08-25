import { useState } from 'react'
import { supabase } from '../supabaseClient'

export default function MomentExpandMenu({ momentId, session, likes, onLikesChanged, onRequestComment, onRequestAnonymousComment, isOwner, onDelete, deleting }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [pending, setPending] = useState(false)

  const liked = likes.some((l) => l.user_id === session.user.id)

  async function handleToggleLike() {
    if (pending) return
    setPending(true)
    if (liked) {
      const { error } = await supabase
        .from('likes')
        .delete()
        .eq('moment_id', momentId)
        .eq('user_id', session.user.id)
      if (!error) onLikesChanged(likes.filter((l) => l.user_id !== session.user.id))
    } else {
      const { data, error } = await supabase
        .from('likes')
        .insert({ moment_id: momentId, user_id: session.user.id })
        .select('user_id, profiles(nickname)')
        .single()
      if (!error && data) onLikesChanged([...likes, data])
    }
    setPending(false)
    setMenuOpen(false)
  }

  function handleComment() {
    setMenuOpen(false)
    onRequestComment()
  }

  function handleAnonymousComment() {
    setMenuOpen(false)
    onRequestAnonymousComment()
  }

  function handleDelete() {
    setMenuOpen(false)
    onDelete()
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
          <button type="button" className={liked ? 'liked' : ''} onClick={handleToggleLike} disabled={pending}>
            {liked ? '✓ 赞' : '♥ 赞'}
          </button>
          <button type="button" onClick={handleComment}>💬 评论</button>
          <button type="button" className="anon" onClick={handleAnonymousComment}>🎭 匿名评论</button>
          {isOwner && (
            <button type="button" className="danger" onClick={handleDelete} disabled={deleting}>
              {deleting ? '删除中…' : '🗑 删除'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}