import { useState } from 'react'
import { supabase } from '../supabaseClient'

export default function CommentSection({ momentId, session, comments, open, onCommentAdded }) {
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

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

  return (
    <div className="comment-section">
      {comments.length > 0 && (
        <ul className="comment-list">
          {comments.map((c) => {
            const nickname = c.profiles?.nickname ?? c.nickname ?? '匿名'
            const avatarUrl = c.profiles?.avatar_url
            return (
              <li key={c.id} className="comment-item">
                <span className="comment-avatar">
                  {avatarUrl ? <img src={avatarUrl} alt="" /> : nickname.slice(0, 1)}
                </span>
                <span className="comment-body">
                  <span className="comment-nickname">{nickname}</span>：{c.content}
                </span>
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
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
