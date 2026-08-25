import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'

export default function ChatList() {
  const session = useAuth()
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, nickname, avatar_url')
        .neq('id', session.user.id)
        .order('nickname')
      if (error) setError(error.message)
      else setProfiles(data)
      setLoading(false)
    }
    load()
  }, [session.user.id])

  if (loading) return <p className="status-text">加载中…</p>
  if (error) return <p className="status-text">加载失败：{error}</p>
  if (profiles.length === 0) return <p className="status-text">还没有其他用户。</p>

  return (
    <ul className="chat-list">
      {profiles.map((p) => (
        <li key={p.id}>
          <Link to={`/chat/${p.id}`} className="chat-list-item">
            <span className="chat-list-avatar">
              {p.avatar_url ? <img src={p.avatar_url} alt="" /> : p.nickname.slice(0, 1)}
            </span>
            <span>{p.nickname}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
