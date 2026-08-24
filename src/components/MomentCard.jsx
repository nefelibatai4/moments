import { useState } from 'react'
import LikeButton from './LikeButton'
import CommentSection from './CommentSection'
import { mapLink } from '../lib/mapLink'
import { getVisitorId } from '../lib/visitorId'
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

export default function MomentCard({ moment, onDeleted }) {
  const [comments, setComments] = useState(moment.comments ?? [])
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)
  const session = useAuth()
  const visitorId = getVisitorId()
  const alreadyLiked = (moment.likes ?? []).some((l) => l.visitor_id === visitorId)
  const isOwner = session && session.user.id === moment.user_id

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
      {moment.content && <p className="moment-content">{moment.content}</p>}

      {moment.images?.length > 0 && (
        <div className={`moment-images ${moment.images.length === 1 ? 'single' : 'grid'}`}>
          {moment.images.map((url, i) => (
            <img key={i} src={url} alt="" loading="lazy" />
          ))}
        </div>
      )}

      <div className="moment-meta">
        <time>{formatTime(moment.created_at)}</time>
        {moment.latitude != null && moment.longitude != null && (
          <a
            className="moment-location"
            href={mapLink(moment.latitude, moment.longitude)}
            target="_blank"
            rel="noopener noreferrer"
          >
            📍 查看位置
          </a>
        )}
      </div>

      <div className="moment-actions">
        <LikeButton
          momentId={moment.id}
          initialCount={moment.likes?.length ?? 0}
          initiallyLiked={alreadyLiked}
        />
        {isOwner && (
          <button className="delete-button" onClick={handleDelete} disabled={deleting}>
            {deleting ? '删除中…' : '删除'}
          </button>
        )}
      </div>
      {deleteError && <p className="error-text">{deleteError}</p>}

      <CommentSection
        momentId={moment.id}
        comments={comments}
        onCommentAdded={(c) => setComments((prev) => [...prev, c])}
      />
    </article>
  )
}
