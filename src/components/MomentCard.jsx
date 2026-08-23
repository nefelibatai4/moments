import { useState } from 'react'
import LikeButton from './LikeButton'
import CommentSection from './CommentSection'
import { mapLink } from '../lib/mapLink'
import { getVisitorId } from '../lib/visitorId'

function formatTime(iso) {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { hour12: false })
}

export default function MomentCard({ moment }) {
  const [comments, setComments] = useState(moment.comments ?? [])
  const visitorId = getVisitorId()
  const alreadyLiked = (moment.likes ?? []).some((l) => l.visitor_id === visitorId)

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
      </div>

      <CommentSection
        momentId={moment.id}
        comments={comments}
        onCommentAdded={(c) => setComments((prev) => [...prev, c])}
      />
    </article>
  )
}
