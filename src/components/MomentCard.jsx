import { useRef, useState } from 'react'
import MomentExpandMenu from './MomentExpandMenu'
import CommentSection from './CommentSection'
import ImageLightbox from './ImageLightbox'
import { mapLink } from '../lib/mapLink'
import { relativeTime } from '../lib/relativeTime'
import { useAuth } from '../lib/AuthContext'
import { supabase } from '../supabaseClient'

function storagePathFromUrl(url) {
  const marker = '/moment-images/'
  const idx = url.indexOf(marker)
  return idx === -1 ? null : url.slice(idx + marker.length)
}

/**
 * 评论和点赞的数据源在 Timeline（单一数据源），这样实时订阅拿到新数据后
 * 能直接反映到卡片上；本组件只保留纯 UI 的开关状态。
 */
export default function MomentCard({
  moment,
  onDeleted,
  onCommentAdded,
  onCommentDeleted,
  onCommentUpdated,
  onCommentLikeChanged,
  onLikesChanged,
  onMomentUpdated,
}) {
  const [commentBoxOpen, setCommentBoxOpen] = useState(false)
  const [anonCommentOpen, setAnonCommentOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)
  const [editing, setEditing] = useState(false)
  // 看图用的下标：null = 没在看。不存 URL 而存下标，是因为图集里要能左右翻页，
  // 翻页时得知道"现在看到第几张了"（见 components/ImageLightbox.jsx）。
  const [viewerIndex, setViewerIndex] = useState(null)
  const [likePending, setLikePending] = useState(false)
  // 双击点赞：`burst` 是那颗心的位置（相对卡片），`id` 换了就重播动画
  const [burst, setBurst] = useState(null)
  const cardRef = useRef(null)
  const lastTapRef = useRef(0)
  const [draft, setDraft] = useState(moment.content ?? '')
  const [saving, setSaving] = useState(false)
  const session = useAuth()
  const isOwner = session && session.user.id === moment.user_id
  const profile = moment.profiles
  const isAnon = !!moment.anon_nickname
  const displayName = moment.anon_nickname || (profile?.nickname ?? '匿名')
  const comments = moment.comments ?? []
  // 信息流里最多铺 9 张（微博那样），更多的用第 9 格盖「+N」；
  // 灯箱拿到的仍是**全部**图片，点开后能一直往后翻。
  const allImages = moment.images ?? []
  const shownImages = allImages.length > 9 ? allImages.slice(0, 9) : allImages
  const moreCount = allImages.length - shownImages.length
  const likes = moment.likes ?? []

  const liked = !!session && likes.some((l) => l.user_id === session.user.id)

  // 点赞/取消赞：从 MomentExpandMenu 搬过来的（现在操作条上的 ♥ 直接点，不用先进 ⋯ 菜单）。
  // ⚠️ 两处 `.select()` 都是为了"确认真的写进去了"：被 RLS 拦下的写操作不报错、只影响 0 行。
  async function handleToggleLike() {
    if (likePending || !session) return
    setLikePending(true)
    if (liked) {
      const { data, error } = await supabase
        .from('likes')
        .delete()
        .eq('moment_id', moment.id)
        .eq('user_id', session.user.id)
        .select('user_id')
      if (!error && data && data.length > 0) {
        onLikesChanged?.(moment.id, likes.filter((l) => l.user_id !== session.user.id))
      }
    } else {
      const { data, error } = await supabase
        .from('likes')
        .insert({ moment_id: moment.id, user_id: session.user.id })
        .select('user_id, profiles(nickname)')
        .single()
      if (!error && data) onLikesChanged?.(moment.id, [...likes, data])
    }
    setLikePending(false)
  }

  /**
   * 双击卡片点赞（微博/Instagram 那种：双击任意空白处 → 冒一颗心 + 顺手点赞）。
   *
   * 为什么自己判"双击"而不是用 onDoubleClick：iOS 上 `dblclick` 的触发时机不牢靠，
   * 而"两次 click 在 300ms 内"在鼠标与触摸上是同一套逻辑，也更好写用例。
   * ⚠️ 必须让开这些地方：图片（单击是开灯箱）、按钮/链接、评论区 —— 否则会抢别人的交互。
   */
  function handleClick(e) {
    if (e.target.closest('button, a, input, textarea, .moment-images, .comment-section, .moment-actions')) return
    const now = Date.now()
    if (now - lastTapRef.current > 300) {
      lastTapRef.current = now
      return
    }
    lastTapRef.current = 0
    const rect = cardRef.current?.getBoundingClientRect()
    if (rect) setBurst({ x: e.clientX - rect.left, y: e.clientY - rect.top, id: now })
    // 已经赞过就只放动画（微博也是这个行为：双击不取消赞）
    if (session && !liked) handleToggleLike()
  }

  function startEdit() {
    setDraft(moment.content ?? '')
    setDeleteError(null)
    setEditing(true)
  }

  async function handleSaveEdit(e) {
    e.preventDefault()
    setSaving(true)
    setDeleteError(null)
    try {
      const next = draft.trim()
      // 必须带 .select() 才知道"到底改了几行"：
      // 被 RLS 拦下的 update **不会返回错误**，只是影响 0 行。不加这层判断，
      // 界面会显示保存成功、实际库里一个字都没变。
      const { data, error } = await supabase
        .from('moments')
        .update({ content: next || null })
        .eq('id', moment.id)
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) {
        throw new Error('保存失败：这条动态不存在，或你没有修改权限')
      }
      onMomentUpdated?.(moment.id, { content: next || null })
      setEditing(false)
    } catch (err) {
      setDeleteError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!window.confirm('确定要删除这条动态吗？')) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const paths = (moment.images ?? []).map(storagePathFromUrl).filter(Boolean)
      if (paths.length > 0) {
        await supabase.storage.from('moment-images').remove(paths)
      }
      // 同样要确认真的删掉了：被 RLS 拦下的 delete 不报错、只影响 0 行，
      // 不确认的话界面显示已删除、刷新后动态会"复活"。
      const { data: deleted, error } = await supabase
        .from('moments')
        .delete()
        .eq('id', moment.id)
        .select('id')
      if (error) throw error
      if (!deleted || deleted.length === 0) {
        throw new Error('删除失败：这条动态不存在，或你没有删除权限')
      }
      onDeleted?.(moment.id)
    } catch (err) {
      setDeleteError(err.message)
      setDeleting(false)
    }
  }

  return (
    <article className="moment-card" ref={cardRef} onClick={handleClick}>
      <div className="moment-header">
        <span className="moment-avatar">
          {!isAnon && profile?.avatar_url ? (
            <img src={profile.avatar_url} alt="" />
          ) : (
            displayName.slice(0, 1)
          )}
        </span>
        {/* 上行 ID、下行时间（微博那种；字体与颜色都不变，只是换了位置）。
            ⚠️ ID 长度有上限（见 docs/STATUS.md）：太长会把第一行撑到折行、卡片头变成三行。 */}
        <span className="moment-author">
          <span className="moment-author-name">{displayName}</span>
          <span className="moment-author-time">{relativeTime(moment.created_at)}</span>
        </span>
        <span className="moment-meta-spacer" />
        {moment.latitude != null && moment.longitude != null && (
          <a
            className="moment-location"
            href={mapLink(moment.latitude, moment.longitude)}
            target="_blank"
            rel="noopener noreferrer"
          >
            📍 位置
          </a>
        )}
        {session && (
          <MomentExpandMenu
            onRequestAnonymousComment={() => { setAnonCommentOpen(true); setCommentBoxOpen(false) }}
            isOwner={isOwner}
            onEdit={startEdit}
            onDelete={handleDelete}
            deleting={deleting}
          />
        )}
      </div>

      {editing ? (
        <form className="moment-edit-form" onSubmit={handleSaveEdit}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={1000}
            autoFocus
          />
          <div className="moment-edit-actions">
            <button type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
            <button type="button" className="ghost" onClick={() => setEditing(false)} disabled={saving}>
              取消
            </button>
          </div>
        </form>
      ) : (
        moment.content && <p className="moment-content">{moment.content}</p>
      )}

      {allImages.length > 0 && (
        <div className={`moment-images ${allImages.length === 1 ? 'single' : 'grid'}`}>
          {shownImages.map((url, i) => (
            // 包一层 button：鼠标能点、键盘能 Tab 到再回车，屏幕阅读器也知道这是能按的。
            // ⚠️ 点第几张就要开第几张 —— 只传 url 不传下标的话，多图动态里点第 3 张
            //    打开的是第 1 张，图长得像的时候根本看不出来（回归用例 verify-moment-gallery）。
            <button
              key={i}
              type="button"
              className="moment-image-btn no-opacity-hover"
              aria-label={`查看第 ${i + 1} 张图片`}
              onClick={() => setViewerIndex(i)}
            >
              <img src={url} alt="" loading="lazy" />
              {moreCount > 0 && i === shownImages.length - 1 && (
                <span className="moment-image-more">+{moreCount}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* 底部操作条：微博那种"赞 / 评论 + 数字"。
          使用者 2026-09-30 定的口径：不做转发，先只放这两个。
          点赞直接在这里点（原来藏在右上 ⋯ 菜单里），⋯ 里只剩匿名评论/编辑/删除。 */}
      {session && (
        <div className="moment-actions">
          <button
            type="button"
            className={`moment-act${liked ? ' liked' : ''}${likePending ? ' popping' : ''}`}
            onClick={handleToggleLike}
            disabled={likePending}
            aria-pressed={liked}
            aria-label={liked ? '取消赞' : '赞'}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M12 20.2l-1.05-.95C6.2 14.9 3.2 12.2 3.2 8.7 3.2 6.1 5.2 4 7.8 4c1.5 0 2.9.7 3.8 1.8l.4.5.4-.5C13.3 4.7 14.7 4 16.2 4 18.8 4 20.8 6.1 20.8 8.7c0 3.5-3 6.2-7.75 10.55L12 20.2z"
                fill={liked ? 'currentColor' : 'none'}
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
            <span>赞</span>
            {likes.length > 0 && <span className="moment-act-count">{likes.length}</span>}
          </button>
          <button
            type="button"
            className="moment-act"
            onClick={() => {
              // 点一次展开评论区（全部评论 + 正常评论输入框），再点一次收起。
              // 数字始终留在按钮旁边（使用者 2026-09-30 的要求）。
              setCommentBoxOpen((v) => !v)
              setAnonCommentOpen(false)
            }}
            aria-expanded={commentBoxOpen}
            aria-label="评论"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M20.2 11.7c0 3.5-3.5 6.3-7.8 6.3-.95 0-1.9-.14-2.75-.4L5.3 19.6l1.15-3.05C5.4 15.4 4.8 13.7 4.8 11.7c0-3.5 3.5-6.3 7.8-6.3s7.6 2.8 7.6 6.3z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
            <span>评论</span>
            {comments.length > 0 && <span className="moment-act-count">{comments.length}</span>}
          </button>
        </div>
      )}
      {burst && (
        <span
          key={burst.id}
          className="like-burst"
          style={{ left: burst.x, top: burst.y }}
          aria-hidden="true"
          onAnimationEnd={() => setBurst(null)}
        >
          <svg viewBox="0 0 24 24" width="88" height="88">
            <path
              d="M12 20.2l-1.05-.95C6.2 14.9 3.2 12.2 3.2 8.7 3.2 6.1 5.2 4 7.8 4c1.5 0 2.9.7 3.8 1.8l.4.5.4-.5C13.3 4.7 14.7 4 16.2 4 18.8 4 20.8 6.1 20.8 8.7c0 3.5-3 6.2-7.75 10.55L12 20.2z"
              fill="currentColor"
            />
          </svg>
        </span>
      )}
      {deleteError && <p className="error-text">{deleteError}</p>}

      {(likes.length > 0 || comments.length > 0 || commentBoxOpen || anonCommentOpen) && (
        <div className="moment-panel">
          {likes.length > 0 && (
            <p className="moment-likes-line">
              ♥ {likes.map((l) => l.profiles?.nickname ?? '匿名').join('、')}
            </p>
          )}
          {session && (
            <CommentSection
              momentId={moment.id}
              momentOwnerId={moment.user_id}
              session={session}
              comments={comments}
              previewCount={2}
              onExpand={() => { setCommentBoxOpen(true); setAnonCommentOpen(false) }}
              open={commentBoxOpen}
              anonOpen={anonCommentOpen}
              onCommentAdded={(c) => onCommentAdded?.(moment.id, c)}
              onCommentDeleted={(id) => onCommentDeleted?.(moment.id, id)}
              onCommentUpdated={(id, fields) => onCommentUpdated?.(moment.id, id, fields)}
              onCommentLikeChanged={(id, likes) => onCommentLikeChanged?.(moment.id, id, likes)}
            />
          )}
        </div>
      )}
      {viewerIndex != null && (
        <ImageLightbox
          images={allImages}
          index={viewerIndex}
          alt={`${displayName} 发布的图片`}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </article>
  )
}
