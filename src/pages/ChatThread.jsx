import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { safeStorageKey } from '../lib/sanitizeFilename'

// 撤回窗口：2 分钟内（与微信一致）
const RECALL_WINDOW_MS = 2 * 60 * 1000

function storagePathFromUrl(url) {
  const marker = '/moment-images/'
  const idx = url.indexOf(marker)
  return idx === -1 ? null : url.slice(idx + marker.length)
}

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
  // 撤回按钮只在 2 分钟窗口内出现。用低频计时器驱动，让按钮在窗口过期后自行消失。
  // （不在 render 里直接调 Date.now()，那会让渲染变成非纯函数）
  const [now, setNow] = useState(() => Date.now())
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
        const belongsToThread =
          (m.sender_id === me && m.recipient_id === userId) ||
          (m.sender_id === userId && m.recipient_id === me)
        if (!belongsToThread) return

        // UPDATE 有两个来源：对方标记已读、发送方撤回（content/image_url 会被清空）。
        // 整行合并即可同时覆盖两种情况，且不再限定只有自己发的消息才处理。
        setMessages((prev) =>
          prev.map((x) =>
            x.id === m.id
              ? { ...x, read_at: m.read_at, recalled_at: m.recalled_at, content: m.content, image_url: m.image_url }
              : x
          )
        )
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
    const timer = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(timer)
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

  async function handleRecall(message) {
    if (!window.confirm('撤回这条消息？对方将看不到内容。')) return
    setError(null)
    try {
      // 顺带把图片从存储里删掉——撤回的语义是"真的删掉"，不只是前端隐藏
      if (message.image_url) {
        const path = storagePathFromUrl(message.image_url)
        if (path) await supabase.storage.from('moment-images').remove([path])
      }
      const { error } = await supabase
        .from('messages')
        .update({ recalled_at: new Date().toISOString(), content: null, image_url: null })
        .eq('id', message.id)
      if (error) throw error
      setMessages((prev) =>
        prev.map((x) =>
          x.id === message.id
            ? { ...x, recalled_at: new Date().toISOString(), content: null, image_url: null }
            : x
        )
      )
    } catch (err) {
      setError(err.message)
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

  // 时间分组标签提前算好（纯计算，不在 JSX 里跨迭代改局部变量）
  const rows = messages.map((m, i) => {
    const label = msgTimeLabel(m.created_at)
    const prevLabel = i > 0 ? msgTimeLabel(messages[i - 1].created_at) : null
    return { message: m, label, showLabel: label !== prevLabel }
  })

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
        {rows.map(({ message: m, label, showLabel }) => {
          const isMine = m.sender_id === me
          const isRecalled = !!m.recalled_at
          const canRecall =
            isMine && !isRecalled && now - new Date(m.created_at).getTime() < RECALL_WINDOW_MS

          return (
            <div key={m.id}>
              {showLabel && <div className="chat-time-label">{label}</div>}
              {isRecalled ? (
                <div className="chat-recalled-line">
                  {isMine ? '你撤回了一条消息' : '对方撤回了一条消息'}
                </div>
              ) : (
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
              )}
              {canRecall && (
                <div className="chat-recall-row">
                  <button type="button" className="chat-recall-btn" onClick={() => handleRecall(m)}>
                    撤回
                  </button>
                </div>
              )}
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
        <button type="submit" disabled={sending || (!content.trim() && !imageFile)}>
          {sending ? '…' : '发送'}
        </button>
      </form>
    </div>
  )
}