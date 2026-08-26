import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { safeStorageKey } from '../lib/sanitizeFilename'

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
  const [imageFile, setImageFile] = useState(null)
  const msgListRef = useRef(null)
  const bottomRef = useRef(null)
  const me = session.user.id

  const imagePreviewUrl = useMemo(
    () => (imageFile ? URL.createObjectURL(imageFile) : null),
    [imageFile]
  )
  useEffect(() => {
    return () => {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl)
    }
  }, [imagePreviewUrl])

  useEffect(() => {
    let cancelled = false

    function isPageActive() {
      return document.visibilityState === 'visible' && document.hasFocus()
    }

    function markUnreadAsRead() {
      supabase
        .from('messages')
        .update({ read_at: new Date().toISOString() })
        .eq('sender_id', userId)
        .eq('recipient_id', me)
        .is('read_at', null)
        .then(({ error }) => { if (error) console.error('mark read error:', error) })
    }

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

      // Mark incoming messages as read only if the page is actually in front of the user
      if (isPageActive()) markUnreadAsRead()
    }
    load()

    const onBecomeActive = () => {
      if (isPageActive()) markUnreadAsRead()
    }
    document.addEventListener('visibilitychange', onBecomeActive)
    window.addEventListener('focus', onBecomeActive)

    const channel = supabase
      .channel(`messages-${[me, userId].sort().join('-')}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new
        if (
          (m.sender_id === me && m.recipient_id === userId) ||
          (m.sender_id === userId && m.recipient_id === me)
        ) {
          setMessages((prev) => [...prev, m])
          // If it's from the other person and the page is in front, mark read immediately
          if (m.sender_id === userId && isPageActive()) {
            supabase
              .from('messages')
              .update({ read_at: new Date().toISOString() })
              .eq('id', m.id)
              .then(({ error }) => { if (error) console.error('mark read error:', error) })
          }
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new
        if (m.sender_id === me && m.recipient_id === userId) {
          setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, read_at: m.read_at } : x)))
        }
      })
      .subscribe()

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onBecomeActive)
      window.removeEventListener('focus', onBecomeActive)
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
    if ((!content.trim() && !imageFile) || sending) return
    setSending(true)
    setError(null)
    try {
      let imageUrl = null
      if (imageFile) {
        const path = safeStorageKey(me, imageFile.name)
        const { error: uploadError } = await supabase.storage
          .from('moment-images')
          .upload(path, imageFile)
        if (uploadError) throw uploadError
        const { data: publicUrlData } = supabase.storage
          .from('moment-images')
          .getPublicUrl(path)
        imageUrl = publicUrlData.publicUrl
      }
      const { error } = await supabase
        .from('messages')
        .insert({ sender_id: me, recipient_id: userId, content: content.trim() || null, image_url: imageUrl })
      if (error) throw error
      setContent('')
      setImageFile(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setSending(false)
    }
  }

  if (loading) return <p className="status-text">加载中…</p>

  function handlePaste(e) {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) setImageFile(file)
        return
      }
    }
  }

  let lastTimeLabel = null

  return (
    <div className="chat-thread" onPaste={handlePaste}>
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
                  {m.image_url && (
                    <a href={m.image_url} target="_blank" rel="noopener noreferrer" className="chat-bubble-image">
                      <img src={m.image_url} alt="" />
                    </a>
                  )}
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
        <label className="chat-attach-btn" title="发送图片">
          📷
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => setImageFile(e.target.files[0] ?? null)}
          />
        </label>
        {imageFile && (
          <span className="chat-attach-preview">
            <img src={imagePreviewUrl} alt="" />
            <button
              type="button"
              className="chat-attach-remove"
              onClick={() => setImageFile(null)}
              aria-label="移除图片"
            >
              ×
            </button>
          </span>
        )}
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