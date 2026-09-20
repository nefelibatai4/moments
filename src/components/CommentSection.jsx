import { useState } from 'react'
import { supabase } from '../supabaseClient'

// 评论的显示名：nickname 有值说明是匿名评论，优先用它
function commentName(c) {
  return c.nickname ?? c.profiles?.nickname ?? '匿名'
}

/**
 * 把扁平评论整理成「顶层评论 + 它下面的回复」。
 *
 * 数据库里回复只是 parent_id 指向某条评论，是扁平的；界面要分两层显示，
 * 所以在这里分组。回复的回复（多级）会被压到同一层——只显示两级，
 * 避免深层嵌套在手机窄屏上没法看。
 */
function buildThreads(comments) {
  const byId = new Map(comments.map((c) => [c.id, c]))
  const roots = []
  const repliesByRoot = new Map()

  for (const c of comments) {
    const parent = c.parent_id ? byId.get(c.parent_id) : null
    if (!parent) {
      roots.push(c)
      continue
    }
    // 沿 parent 往上找到最顶层那条（加 guard 防意外成环）
    let root = parent
    let guard = 0
    while (root.parent_id && byId.has(root.parent_id) && guard++ < 10) {
      root = byId.get(root.parent_id)
    }
    if (!repliesByRoot.has(root.id)) repliesByRoot.set(root.id, [])
    repliesByRoot.get(root.id).push(c)
  }
  return { roots, repliesByRoot, byId }
}

export default function CommentSection({
  momentId,
  momentOwnerId,
  session,
  comments,
  open,
  anonOpen,
  onCommentAdded,
  onCommentDeleted,
  onCommentLikeChanged,
}) {
  const [content, setContent] = useState('')
  const [anonContent, setAnonContent] = useState('')
  const [anonNickname, setAnonNickname] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [replyContent, setReplyContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [likingId, setLikingId] = useState(null)
  const [error, setError] = useState(null)

  const me = session?.user?.id

  // 评论作者本人，或这条动态的作者，都可以删
  function canDelete(comment) {
    if (!session) return false
    return comment.user_id === me || momentOwnerId === me
  }

  function likedByMe(comment) {
    return (comment.comment_likes ?? []).some((l) => l.user_id === me)
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
      .insert({ moment_id: momentId, user_id: me, content: content.trim() })
      .select('*, profiles(nickname, avatar_url)')
      .single()

    if (insertError) setError(insertError.message)
    else if (data) {
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

    // 匿名只体现在显示名上：仍记录真实 user_id，这样作者本人能删自己的匿名评论
    const { data, error: insertError } = await supabase
      .from('comments')
      .insert({
        moment_id: momentId,
        user_id: me,
        nickname: anonNickname.trim(),
        content: anonContent.trim(),
      })
      .select('*, profiles(nickname, avatar_url)')
      .single()

    if (insertError) setError(insertError.message)
    else if (data) {
      onCommentAdded(data)
      setAnonContent('')
      setAnonNickname('')
    }
    setSubmitting(false)
  }

  async function handleReplySubmit(e) {
    e.preventDefault()
    if (!replyContent.trim()) {
      setError('请输入回复内容')
      return
    }
    setSubmitting(true)
    setError(null)

    const { data, error: insertError } = await supabase
      .from('comments')
      .insert({
        moment_id: momentId,
        user_id: me,
        parent_id: replyTo.id,
        content: replyContent.trim(),
      })
      .select('*, profiles(nickname, avatar_url)')
      .single()

    if (insertError) setError(insertError.message)
    else if (data) {
      onCommentAdded(data)
      setReplyContent('')
      setReplyTo(null)
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

  async function handleToggleLike(comment) {
    if (likingId) return
    setLikingId(comment.id)
    setError(null)
    const current = comment.comment_likes ?? []

    if (likedByMe(comment)) {
      // 带 .select() 才能确认真的删掉了（RLS 拦下的删除不报错，只会影响 0 行）
      const { data, error: delError } = await supabase
        .from('comment_likes')
        .delete()
        .eq('comment_id', comment.id)
        .eq('user_id', me)
        .select('user_id')
      if (delError) setError(delError.message)
      else if (data && data.length > 0) {
        onCommentLikeChanged?.(comment.id, current.filter((l) => l.user_id !== me))
      }
    } else {
      const { data, error: insError } = await supabase
        .from('comment_likes')
        .insert({ comment_id: comment.id, user_id: me })
        .select('user_id')
        .single()
      if (insError) setError(insError.message)
      else if (data) onCommentLikeChanged?.(comment.id, [...current, data])
    }
    setLikingId(null)
  }

  function renderReplyForm(target) {
    return (
      <form className="comment-form comment-reply-form" onSubmit={handleReplySubmit}>
        <input
          type="text"
          placeholder={`回复 ${commentName(target)}…`}
          value={replyContent}
          onChange={(e) => setReplyContent(e.target.value)}
          maxLength={200}
          autoFocus
        />
        <button type="submit" disabled={submitting}>回复</button>
        <button
          type="button"
          className="ghost"
          onClick={() => { setReplyTo(null); setReplyContent('') }}
          disabled={submitting}
        >
          取消
        </button>
      </form>
    )
  }

  function renderComment(comment, parentComment) {
    const nickname = commentName(comment)
    const avatarUrl = comment.nickname ? null : comment.profiles?.avatar_url
    const likes = comment.comment_likes ?? []
    const liked = likedByMe(comment)

    return (
      <li key={comment.id} className={parentComment ? 'comment-item comment-item-reply' : 'comment-item'}>
        <span className="comment-avatar">
          {avatarUrl ? <img src={avatarUrl} alt="" /> : nickname.slice(0, 1)}
        </span>
        <span className="comment-body">
          <span className="comment-nickname">{nickname}</span>
          {parentComment && (
            <>
              {' '}回复 <span className="comment-nickname">{commentName(parentComment)}</span>
            </>
          )}
          ：{comment.content}
          <span className="comment-actions">
            <button
              type="button"
              className={liked ? 'comment-like-btn liked' : 'comment-like-btn'}
              onClick={() => handleToggleLike(comment)}
              disabled={likingId === comment.id}
              title={liked ? '取消点赞' : '点赞'}
            >
              ♥{likes.length > 0 ? ` ${likes.length}` : ''}
            </button>
            <button
              type="button"
              className="comment-reply-btn"
              onClick={() => { setReplyTo(comment); setReplyContent('') }}
            >
              回复
            </button>
          </span>
        </span>
        {canDelete(comment) && (
          <button
            type="button"
            className="comment-delete"
            onClick={() => handleDelete(comment)}
            disabled={deletingId === comment.id}
            aria-label="删除评论"
            title="删除评论"
          >
            ×
          </button>
        )}
      </li>
    )
  }

  const { roots, repliesByRoot, byId } = buildThreads(comments)

  return (
    <div className="comment-section">
      {roots.length > 0 && (
        <ul className="comment-list">
          {roots.map((root) => (
            <li key={root.id} className="comment-thread">
              <ul className="comment-list comment-list-nested">
                {renderComment(root, null)}
                {(repliesByRoot.get(root.id) ?? []).map((reply) =>
                  renderComment(reply, byId.get(reply.parent_id))
                )}
              </ul>
              {replyTo?.id === root.id && renderReplyForm(root)}
            </li>
          ))}
        </ul>
      )}

      {/* 回复的是一条回复时，表单挂在最外层 */}
      {replyTo && !roots.some((r) => r.id === replyTo.id) && (
        <div className="comment-reply-standalone">{renderReplyForm(replyTo)}</div>
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
