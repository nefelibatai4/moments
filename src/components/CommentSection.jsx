import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'

// 评论的显示名：nickname 有值说明是匿名评论，优先用它
function commentName(c) {
  return c.nickname ?? c.profiles?.nickname ?? '匿名'
}

// 编辑窗口：2 分钟内（与私信编辑/撤回一致）。
// 服务端 protect_comment_fields() 里有同一份强制，这里只控制入口出不出来。
const EDIT_WINDOW_MS = 2 * 60 * 1000

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
  onCommentUpdated,
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
  // ⋯ 操作菜单展开在哪条评论上；null = 全收起
  const [menuFor, setMenuFor] = useState(null)
  // 正在内联编辑的评论：{ id, text }
  const [editing, setEditing] = useState(null)
  // 编辑入口只在 2 分钟窗口内出现。用低频计时器驱动，让入口在窗口过期后自行消失
  // （不在 render 里直接调 Date.now()，那会让渲染变成非纯函数）
  const [now, setNow] = useState(() => Date.now())

  const me = session?.user?.id

  // 低频刷新 now：只影响"编辑"入口的显隐，30 秒精度足够
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [])

  // 点别处 / 按 Esc 收起操作菜单。
  // ⋯ 按钮与菜单项自己 stopPropagation，否则「再点一次 ⋯ 收起」会被这里立刻又关掉。
  useEffect(() => {
    if (!menuFor) return
    const close = () => setMenuFor(null)
    const onKey = (e) => { if (e.key === 'Escape') setMenuFor(null) }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuFor])

  // 删除：评论作者本人，或这条动态的作者
  function canDelete(comment) {
    if (!session) return false
    return comment.user_id === me || momentOwnerId === me
  }

  // 编辑：仅评论作者本人，且在 2 分钟窗口内（服务端另有强制）
  function canEdit(comment) {
    if (!session || comment.user_id !== me) return false
    return now - new Date(comment.created_at).getTime() < EDIT_WINDOW_MS
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

    // 匿名只体现在显示名上：仍记录真实 user_id，这样作者本人能删/能编辑自己的匿名评论
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
    // 带 .select() 确认真的删掉了：被 RLS 拦下的 delete 不报错、只影响 0 行。
    // 不确认的话界面会显示已删除，刷新后评论却"复活"。
    const { data: deleted, error: deleteError } = await supabase
      .from('comments')
      .delete()
      .eq('id', comment.id)
      .select('id')
    if (deleteError) setError(deleteError.message)
    else if (!deleted || deleted.length === 0) setError('删除失败：这条评论不存在，或你没有删除权限')
    else onCommentDeleted?.(comment.id)
    setDeletingId(null)
  }

  async function handleSaveEdit() {
    if (!editing) return
    const next = editing.text.trim()
    if (!next) {
      setError('评论内容不能为空')
      return
    }
    setError(null)
    // .select() 不能省：被 RLS / 触发器拦下的写不报错、只影响 0 行（PITFALLS #32）。
    // edited_at 由服务端触发器写，这里不传（传了也会被覆盖）。
    const { data, error: updateError } = await supabase
      .from('comments')
      .update({ content: next })
      .eq('id', editing.id)
      .select('id')
    if (updateError) {
      // 超过 2 分钟窗口 / 改了不该改的字段会在这里报错
      setError(updateError.message)
    } else if (!data || data.length === 0) {
      setError('编辑没有生效（可能已超过 2 分钟窗口，或你不是评论作者）')
    } else {
      onCommentUpdated?.(editing.id, { content: next, edited_at: new Date().toISOString() })
      setEditing(null)
    }
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
    const isEditing = editing?.id === comment.id
    const canEditThis = canEdit(comment) && !isEditing
    const hasMenu = !!session

    return (
      <li key={comment.id} className={parentComment ? 'comment-item comment-item-reply' : 'comment-item'}>
        <span className="comment-avatar">
          {avatarUrl ? <img src={avatarUrl} alt="" /> : nickname.slice(0, 1)}
        </span>
        <div className="comment-body">
          <span className="comment-nickname">{nickname}</span>
          {parentComment && (
            <>
              {' '}回复 <span className="comment-nickname">{commentName(parentComment)}</span>
            </>
          )}
          ：{isEditing ? (
            <span className="comment-edit">
              <textarea
                className="comment-edit-input"
                rows={2}
                maxLength={200}
                autoFocus
                value={editing.text}
                onChange={(e) => setEditing((s) => ({ ...s, text: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSaveEdit()
                  }
                  if (e.key === 'Escape') setEditing(null)
                }}
              />
              <span className="comment-edit-actions">
                <button type="button" onClick={() => setEditing(null)}>取消</button>
                <button type="button" className="primary" onClick={handleSaveEdit}>保存</button>
              </span>
            </span>
          ) : (
            <>
              {comment.content}
              {comment.edited_at && <span className="comment-edited-tag">已编辑</span>}
            </>
          )}
          {/* 点赞数保留为纯文字（一眼能看到热度）；点赞/取消点赞的操作在 ⋯ 菜单里 */}
          {likes.length > 0 && (
            <span className={liked ? 'comment-likes-count liked' : 'comment-likes-count'}>
              ♥ {likes.length}
            </span>
          )}
        </div>
        {hasMenu && (
          <div className="comment-menu-wrap">
            <button
              type="button"
              className="comment-more"
              aria-label="评论操作"
              title="评论操作"
              onClick={(e) => {
                // 不 stopPropagation 的话，document 上那个"点别处收起"
                // 会立刻把它关掉，表现为按钮点了没反应
                e.stopPropagation()
                setMenuFor(menuFor === comment.id ? null : comment.id)
              }}
            >
              ⋯
            </button>
            {menuFor === comment.id && (
              <div className="comment-menu" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  onClick={() => { setMenuFor(null); handleToggleLike(comment) }}
                  disabled={likingId === comment.id}
                >
                  {liked ? '取消点赞' : '点赞'}
                </button>
                <button
                  type="button"
                  onClick={() => { setReplyTo(comment); setReplyContent(''); setMenuFor(null) }}
                >
                  回复
                </button>
                {canEditThis && (
                  <button
                    type="button"
                    onClick={() => { setEditing({ id: comment.id, text: comment.content ?? '' }); setMenuFor(null) }}
                  >
                    编辑
                  </button>
                )}
                {canDelete(comment) && (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => { setMenuFor(null); handleDelete(comment) }}
                    disabled={deletingId === comment.id}
                  >
                    删除
                  </button>
                )}
              </div>
            )}
          </div>
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
