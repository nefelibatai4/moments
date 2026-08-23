import { useState } from 'react'
import { supabase } from '../supabaseClient'
import { getVisitorId } from '../lib/visitorId'

export default function LikeButton({ momentId, initialCount, initiallyLiked }) {
  const [count, setCount] = useState(initialCount)
  const [liked, setLiked] = useState(initiallyLiked)
  const [pending, setPending] = useState(false)

  async function handleLike() {
    if (liked || pending) return
    setPending(true)
    const visitorId = getVisitorId()
    const { error } = await supabase
      .from('likes')
      .insert({ moment_id: momentId, visitor_id: visitorId })

    if (!error) {
      setLiked(true)
      setCount((c) => c + 1)
    }
    setPending(false)
  }

  return (
    <button className={`like-button ${liked ? 'liked' : ''}`} onClick={handleLike} disabled={liked || pending}>
      ♥ {count}
    </button>
  )
}
