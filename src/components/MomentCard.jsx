import { useState } from 'react'
import MomentExpandMenu from './MomentExpandMenu'
import CommentSection from './CommentSection'
import { mapLink } from '../lib/mapLink'
import { useAuth } from '../lib/AuthContext'
import { supabase } from '../supabaseClient'

function formatTime(iso) {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { hour12: false })
}

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
  onCommentLikeChanged,
  onLikesChanged,
  onMomentUpdated,
}) {
  const [commentBoxOpen, setCommentBoxOpen] = useState(false)
  const [anonCommentOpen, setAnonCommentOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(moment.content ?? '')
  const [saving, setSaving] = useState(false)
  const session = useAuth()
  const isOwner = session && session.user.id === moment.user_id
  const profile = moment.profiles
  const isAnon = !!moment.anon_nickname
  const displayName = moment.anon_nickname || (profile?.nickname ?? '匿名')
  const comments = moment.comments ?? []
  const likes = moment.likes ?? []

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
      const { error } = await supabase.from('moments').delete().eq('id', moment.id)
      if (error) throw error
      onDeleted?.(moment.id)
    } catch (err) {
      setDeleteError(err.message)
      setDeleting(false)
    }
  }

  return (
    <article className="moment-card">
      <div className="moment-header">
        <span className="moment-avatar">
          {!isAnon && profile?.avatar_url ? (
            <img src={profile.avatar_url} alt="" />
          ) : (
            displayName.slice(0, 1)
          )}
        </span>
        <span className="moment-author">
          <span className="moment-author-name">
            {displayName}
            <span className="moment-author-time">· {formatTime(moment.created_at)}</span>
          </span>
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
            momentId={moment.id}
            session={session}
            likes={likes}
            onLikesChanged={(next) => onLikesChanged?.(moment.id, next)}
            onRequestComment={() => { setCommentBoxOpen(true); setAnonCommentOpen(false) }}
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

      {moment.images?.length > 0 && (
        <div className={`moment-images ${moment.images.length === 1 ? 'single' : 'grid'}`}>
          {moment.images.map((url, i) => (
            <img key={i} src={url} alt="" loading="lazy" />
          ))}
        </div>
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
              open={commentBoxOpen}
              anonOpen={anonCommentOpen}
              onCommentAdded={(c) => onCommentAdded?.(moment.id, c)}
              onCommentDeleted={(id) => onCommentDeleted?.(moment.id, id)}
              onCommentLikeChanged={(id, likes) => onCommentLikeChanged?.(moment.id, id, likes)}
            />
          )}
        </div>
      )}
    </article>
  )
}

