import { useState } from 'react'
import { supabase } from '../supabaseClient'

export default function CommentSection({
  momentId,
  momentOwnerId,
  session,
  comments,
  open,
  anonOpen,
  onCommentAdded,
  onCommentDeleted,
}) {
  const [content, setContent] = useState('')
  const [anonContent, setAnonContent] = useState('')
  const [anonNickname, setAnonNickname] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [error, setError] = useState(null)

  // 评论作者本人，或这条动态的作者，都可以删
  function canDelete(comment) {
    if (!session) return false
    return comment.user_id === session.user.id || momentOwnerId === session.user.id
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!content.trim()) {
      setError('请输入评论内容')
      return
    }
    setSubmitting(true)
    setError(null)

    const { data, error: insertError } = await supabase
      .from('comments')
      .insert({ moment_id: momentId, user_id: session.user.id, content: content.trim() })
      .select('*, profiles(nickname, avatar_url)')
      .single()

    if (insertError) {
      setError(insertError.message)
    } else if (data) {
      onCommentAdded(data)
      setContent('')
    }
    setSubmitting(false)
  }

  async function handleAnonSubmit(e) {
    e.preventDefault()
    if (!anonNickname.trim() || !anonContent.trim()) {
      setError('请输入昵称和评论内容')
      return
    }
    setSubmitting(true)
    setError(null)

    // 匿名只体现在显示名上：仍然记录真实 user_id，这样作者本人能删自己的匿名评论。
    // （与"匿名发布动态"的处理一致——后台关联真实账号，前台显示自定义名称）
    const { data, error: insertError } = await supabase
      .from('comments')
      .insert({
        moment_id: momentId,
        user_id: session.user.id,
        nickname: anonNickname.trim(),
        content: anonContent.trim(),
      })
      .select('*, profiles(nickname, avatar_url)')
      .single()

    if (insertError) {
      setError(insertError.message)
    } else if (data) {
      onCommentAdded(data)
      setAnonContent('')
      setAnonNickname('')
    }
    setSubmitting(false)
  }

  async function handleDelete(comment) {
    if (!window.confirm('删除这条评论？')) return
    setDeletingId(comment.id)
    setError(null)
    const { error: deleteError } = await supabase.from('comments').delete().eq('id', comment.id)
    if (deleteError) setError(deleteError.message)
    else onCommentDeleted?.(comment.id)
    setDeletingId(null)
  }

  return (
    <div className="comment-section">
      {comments.length > 0 && (
        <ul className="comment-list">
          {comments.map((c) => {
            // nickname 有值说明是匿名评论，优先用它；否则用资料昵称
            const nickname = c.nickname ?? c.profiles?.nickname ?? '匿名'
            const avatarUrl = c.nickname ? null : c.profiles?.avatar_url
            return (
              <li key={c.id} className="comment-item">
                <span className="comment-avatar">
                  {avatarUrl ? <img src={avatarUrl} alt="" /> : nickname.slice(0, 1)}
                </span>
                <span className="comment-body">
                  <span className="comment-nickname">{nickname}</span>：{c.content}
                </span>
                {canDelete(c) && (
                  <button
                    type="button"
                    className="comment-delete"
                    onClick={() => handleDelete(c)}
                    disabled={deletingId === c.id}
                    aria-label="删除评论"
                    title="删除评论"
                  >
                    ×
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {open && (
        <form className="comment-form" onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="说点什么…"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={200}
            autoFocus
          />
          <button type="submit" disabled={submitting}>发送</button>
        </form>
      )}
      {anonOpen && (
        <form className="comment-form anon-form" onSubmit={handleAnonSubmit}>
          <input
            type="text"
            placeholder="自定义昵称"
            value={anonNickname}
            onChange={(e) => setAnonNickname(e.target.value)}
            maxLength={30}
            autoFocus
          />
          <input
            type="text"
            placeholder="匿名说点什么…"
            value={anonContent}
            onChange={(e) => setAnonContent(e.target.value)}
            maxLength={200}
          />
          <button type="submit" disabled={submitting}>匿名发送</button>
        </form>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
