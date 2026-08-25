import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'

function formatChatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now - d
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin}分钟前`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}小时前`
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay < 7) return `${diffDay}天前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function truncate(text, max = 30) {
  return text.length > max ? text.slice(0, max) + '…' : text
}

export default function ChatList() {
  const session = useAuth()
  const [conversations, setConversations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    async function load() {
      const me = session.user.id
      const [profileRes, msgRes, unreadRes] = await Promise.all([
        supabase.from('profiles').select('id, nickname, avatar_url').neq('id', me),
        supabase
          .from('messages')
          .select('sender_id, recipient_id, content, created_at, read_at')
          .or(`sender_id.eq.${me},recipient_id.eq.${me}`)
          .order('created_at', { ascending: false })
          .limit(500),
        supabase
          .from('messages')
          .select('sender_id')
          .eq('recipient_id', me)
          .is('read_at', null),
      ])
      if (profileRes.error) setError(profileRes.error.message)
      else {
        const unreadCounts = {}
        for (const m of (unreadRes.data || [])) {
          unreadCounts[m.sender_id] = (unreadCounts[m.sender_id] || 0) + 1
        }

        const latestByPartner = {}
        for (const m of (msgRes.data || [])) {
          const partnerId = m.sender_id === me ? m.recipient_id : m.sender_id
          if (!latestByPartner[partnerId]) {
            latestByPartner[partnerId] = { content: m.content, created_at: m.created_at }
          }
        }

        const merged = profileRes.data.map((p) => ({
          ...p,
          lastMsg: latestByPartner[p.id]?.content ?? null,
          lastTime: latestByPartner[p.id]?.created_at ?? null,
          unread: unreadCounts[p.id] || 0,
        }))

        merged.sort((a, b) => {
          const tA = a.lastTime ? new Date(a.lastTime).getTime() : 0
          const tB = b.lastTime ? new Date(b.lastTime).getTime() : 0
          return tB - tA
        })

        setConversations(merged)
      }
      setLoading(false)
    }
    load()
  }, [session.user.id])

  const filtered = useMemo(() => {
    if (!search.trim()) return conversations
    const q = search.toLowerCase()
    return conversations.filter((c) => c.nickname.toLowerCase().includes(q))
  }, [conversations, search])

  if (loading) return <p className="status-text">加载中…</p>
  if (error) return <p className="status-text">加载失败：{error}</p>

  return (
    <div className="chat-page">
      <div className="chat-search">
        <input
          type="text"
          placeholder="搜索联系人…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {filtered.length === 0 ? (
        <p className="status-text">还没有聊天记录。</p>
      ) : (
        <ul className="chat-list">
          {filtered.map((c) => (
            <li key={c.id}>
              <Link to={`/chat/${c.id}`} className="chat-list-item">
                <span className="chat-list-avatar">
                  {c.avatar_url ? <img src={c.avatar_url} alt="" /> : c.nickname.slice(0, 1)}
                </span>
                <span className="chat-list-info">
                  <span className="chat-list-name">
                    {c.nickname}
                    {c.unread > 0 && <span className="chat-unread-badge">{c.unread > 99 ? '99+' : c.unread}</span>}
                  </span>
                  {c.lastMsg && <span className="chat-list-preview">{truncate(c.lastMsg)}</span>}
                </span>
                <span className="chat-list-time">{formatChatTime(c.lastTime)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}