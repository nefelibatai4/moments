import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'

export default function ChatThread() {
  const session = useAuth()
  const { userId } = useParams()
  const [otherProfile, setOtherProfile] = useState(null)
  const [messages, setMessages] = useState([])
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const bottomRef = useRef(null)
  const me = session.user.id

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      const [profileRes, messagesRes] = await Promise.all([
        supabase.from('profiles').select('id, nickname, avatar_url').eq('id', userId).single(),
        supabase
          .from('messages')
          .select('*')
          .or(`and(sender_id.eq.${me},recipient_id.eq.${userId}),and(sender_id.eq.${userId},recipient_id.eq.${me})`)
          .order('created_at'),
      ])
      if (cancelled) return
      if (profileRes.error) setError(profileRes.error.message)
      else setOtherProfile(profileRes.data)
      if (messagesRes.error) setError(messagesRes.error.message)
      else setMessages(messagesRes.data)
      setLoading(false)
    }
    load()

    const channel = supabase
      .channel(`messages-${[me, userId].sort().join('-')}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new
        const belongsToThread =
          (m.sender_id === me && m.recipient_id === userId) ||
          (m.sender_id === userId && m.recipient_id === me)
        if (belongsToThread) setMessages((prev) => [...prev, m])
      })
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [me, userId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!content.trim() || sending) return
    setSending(true)
    setError(null)
    const { error } = await supabase
      .from('messages')
      .insert({ sender_id: me, recipient_id: userId, content: content.trim() })
    if (error) setError(error.message)
    else setContent('')
    setSending(false)
  }

  if (loading) return <p className="status-text">加载中…</p>

  return (
    <div className="chat-thread">
      <div className="chat-thread-header">
        <Link to="/chat">← 私聊</Link>
        <h3>{otherProfile?.nickname}</h3>
      </div>
      <div className="chat-messages">
        {messages.map((m) => (
          <div key={m.id} className={`chat-message ${m.sender_id === me ? 'mine' : 'theirs'}`}>
            {m.content}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      {error && <p className="error-text">{error}</p>}
      <form className="chat-input-form" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="发消息…"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={1000}
        />
        <button type="submit" disabled={sending}>发送</button>
      </form>
    </div>
  )
}
