import { useState } from 'react'
import { supabase } from '../supabaseClient'

export default function CommentSection({ momentId, comments, onCommentAdded }) {
  const [nickname, setNickname] = useState('')
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!nickname.trim() || !content.trim() || submitting) return
    setSubmitting(true)

    const { data, error } = await supabase
      .from('comments')
      .insert({ moment_id: momentId, nickname: nickname.trim(), content: content.trim() })
      .select()
      .single()

    if (!error && data) {
      onCommentAdded(data)
      setContent('')
    }
    setSubmitting(false)
  }

  return (
    <div className="comment-section">
      <ul className="comment-list">
        {comments.map((c) => (
          <li key={c.id}>
            <span className="comment-nickname">{c.nickname}</span>：{c.content}
          </li>
        ))}
      </ul>
      <form className="comment-form" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="昵称"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={30}
        />
        <input
          type="text"
          placeholder="说点什么…"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={200}
        />
        <button type="submit" disabled={submitting}>发送</button>
      </form>
    </div>
  )
}
