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

export default function MomentCard({ moment, onDeleted }) {
  const [comments, setComments] = useState(moment.comments ?? [])
  const [likes, setLikes] = useState(moment.likes ?? [])
  const [commentBoxOpen, setCommentBoxOpen] = useState(false)
  const [anonCommentOpen, setAnonCommentOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)
  const session = useAuth()
  const isOwner = session && session.user.id === moment.user_id
  const profile = moment.profiles
  const displayName = moment.anon_nickname || (profile?.nickname ?? '匿名')

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
          {profile?.avatar_url ? (
            <img src={profile.avatar_url} alt="" />
          ) : (
            displayName.slice(0, 1)
          )}
        </span>
        <span className="moment-author">
          <span className="moment-author-name">{displayName}</span>
          <span className="moment-author-time">{formatTime(moment.created_at)}</span>
        </span>
        <span className="moment-meta-spacer" />
        {session && (
          <MomentExpandMenu
            momentId={moment.id}
            session={session}
            likes={likes}
            onLikesChanged={setLikes}
            onRequestComment={() => { setCommentBoxOpen(true); setAnonCommentOpen(false) }}
            onRequestAnonymousComment={() => { setAnonCommentOpen(true); setCommentBoxOpen(false) }}
            isOwner={isOwner}
            onDelete={handleDelete}
            deleting={deleting}
          />
        )}
      </div>

      {moment.content && <p className="moment-content">{moment.content}</p>}

      {moment.images?.length > 0 && (
        <div className={`moment-images ${moment.images.length === 1 ? 'single' : 'grid'}`}>
          {moment.images.map((url, i) => (
            <img key={i} src={url} alt="" loading="lazy" />
          ))}
        </div>
      )}

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
      {deleteError && <p className="error-text">{deleteError}</p>}

      {likes.length > 0 && (
        <p className="moment-likes-line">
          ♥ {likes.map((l) => l.profiles?.nickname ?? '匿名').join('、')}
        </p>
      )}

      {session && (
        <CommentSection
          momentId={moment.id}
          session={session}
          comments={comments}
          open={commentBoxOpen}
          anonOpen={anonCommentOpen}
          onCommentAdded={(c) => setComments((prev) => [...prev, c])}
        />
      )}
    </article>
  )
}

