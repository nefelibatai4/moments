import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'

function msgTimeLabel(iso) {
  const d = new Date(iso)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (isToday) return hm
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`
  return `${d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })} ${hm}`
}

export default function ChatThread() {
  const session = useAuth()
  const { userId } = useParams()
  const [otherProfile, setOtherProfile] = useState(null)
  const [messages, setMessages] = useState([])
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const msgListRef = useRef(null)
  const bottomRef = useRef(null)
  const me = session.user.id

  useEffect(() => {
    let cancelled = false

    async function load() {
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

      // Mark incoming messages as read
      supabase
        .from('messages')
        .update({ read_at: new Date().toISOString() })
        .eq('sender_id', userId)
        .eq('recipient_id', me)
        .is('read_at', null)
        .then(({ error }) => { if (error) console.error('mark read error:', error) })
    }
    load()

    const channel = supabase
      .channel(`messages-${[me, userId].sort().join('-')}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new
        if (
          (m.sender_id === me && m.recipient_id === userId) ||
          (m.sender_id === userId && m.recipient_id === me)
        ) {
          setMessages((prev) => [...prev, m])
          // If it's from the other person, mark it as read immediately
          if (m.sender_id === userId) {
            supabase
              .from('messages')
              .update({ read_at: new Date().toISOString() })
              .eq('id', m.id)
              .then(({ error }) => { if (error) console.error('mark read error:', error) })
          }
        }
      })
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [me, userId])

  useEffect(() => {
    const el = msgListRef.current
    if (!el) return
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight
      setShowScrollBtn(dist > 100)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = msgListRef.current
    if (!el || messages.length === 0) return
    el.scrollTop = el.scrollHeight
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

  let lastTimeLabel = null

  return (
    <div className="chat-thread">
      <div className="chat-thread-header">
        <Link to="/chat" className="chat-back-btn">←</Link>
        <span className="chat-header-avatar">
          {otherProfile?.avatar_url ? (
            <img src={otherProfile.avatar_url} alt="" />
          ) : (
            (otherProfile?.nickname ?? '').slice(0, 1)
          )}
        </span>
        <span className="chat-header-name">{otherProfile?.nickname}</span>
      </div>

      <div className="chat-messages" ref={msgListRef}>
        {messages.map((m) => {
          const label = msgTimeLabel(m.created_at)
          const showLabel = label !== lastTimeLabel
          lastTimeLabel = label
          const isMine = m.sender_id === me

          return (
            <div key={m.id}>
              {showLabel && <div className="chat-time-label">{label}</div>}
              <div className={`chat-bubble-row ${isMine ? 'mine' : 'theirs'}`}>
                <div className={`chat-bubble ${isMine ? 'mine' : 'theirs'}`}>
                  {m.content}
                  {isMine && (
                    <span className={`chat-read-status ${m.read_at ? 'read' : ''}`}>
                      {m.read_at ? '✓✓' : '✓'}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {showScrollBtn && (
        <button className="chat-scroll-btn" onClick={() => {
          const el = msgListRef.current
          if (el) el.scrollTop = el.scrollHeight
        }} aria-label="回到底部">
          ↓
        </button>
      )}

      {error && <p className="error-text">{error}</p>}

      <form className="chat-input-row" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="发消息…"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={1000}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSubmit(e)
            }
          }}
        />
        <button type="submit" disabled={sending || !content.trim()}>
          {sending ? '…' : '发送'}
        </button>
      </form>
    </div>
  )
}