import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { safeStorageKey } from '../lib/sanitizeFilename'
import { compressImage } from '../lib/compressImage'
import ImageLightbox from '../components/ImageLightbox'

// 撤回 / 编辑窗口：2 分钟内（与微信一致）。
// 两个窗口一致，但**服务端各有一份强制**，前端这里只是控制按钮出不出来。
const RECALL_WINDOW_MS = 2 * 60 * 1000
const EDIT_WINDOW_MS = 2 * 60 * 1000
// 聊天历史每次加载的条数
const PAGE_SIZE = 50
// 触屏设备没有 Shift 键。桌面端 Enter 直接发送没问题，但触屏上一旦拦掉 Enter，
// 用户就永远打不出换行——所以触屏让 Enter 保持默认（换行），发送交给右边的按钮。
const isTouchPrimary =
  typeof window !== 'undefined' && !!window.matchMedia?.('(hover: none)').matches

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
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [imageFile, setImageFile] = useState(null)
  // 消息操作菜单（⋯）展开在哪条消息上；null = 全收起
  const [menuFor, setMenuFor] = useState(null)
  // 正在内联编辑的消息：{ id, text }
  const [editing, setEditing] = useState(null)
  // 正在引用的消息，发送时写进 reply_to_id
  const [replyTarget, setReplyTarget] = useState(null)
  // 引用块要显示原消息，但分页只加载最近 50 条；更早的原消息在这里补拉，
  // 否则引用块会显示成空白（而且用户不知道为什么）
  const [quotedCache, setQuotedCache] = useState({})
  // 点开看的图片地址（灯箱）。null = 没打开
  const [lightboxSrc, setLightboxSrc] = useState(null)
  // 操作按钮只在 2 分钟窗口内出现。用低频计时器驱动，让按钮在窗口过期后自行消失。
  // （不在 render 里直接调 Date.now()，那会让渲染变成非纯函数）
  const [now, setNow] = useState(() => Date.now())
  const msgListRef = useRef(null)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)
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
      // 只取最近一页，进来就能用；更早的历史按需加载。
      // 用 desc + limit 拿最新 N 条，再反转成时间正序展示。
      const [profileRes, messagesRes] = await Promise.all([
        supabase.from('profiles').select('id, nickname, avatar_url').eq('id', userId).single(),
        supabase
          .from('messages')
          .select('*')
          .or(`and(sender_id.eq.${me},recipient_id.eq.${userId}),and(sender_id.eq.${userId},recipient_id.eq.${me})`)
          .order('created_at', { ascending: false })
          .limit(PAGE_SIZE),
      ])
      if (cancelled) return
      if (profileRes.error) setError(profileRes.error.message)
      else setOtherProfile(profileRes.data)
      if (messagesRes.error) {
        setError(messagesRes.error.message)
      } else {
        const page = messagesRes.data ?? []
        setMessages(page.slice().reverse())
        setHasMore(page.length === PAGE_SIZE)
      }
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

        // UPDATE 有三个来源：对方标记已读、发送方撤回、发送方编辑。
        // 整行合并即可同时覆盖，且不限定只有自己发的消息才处理。
        setMessages((prev) =>
          prev.map((x) =>
            x.id === m.id
              ? {
                  ...x,
                  read_at: m.read_at,
                  recalled_at: m.recalled_at,
                  content: m.content,
                  image_url: m.image_url,
                  edited_at: m.edited_at,
                  reply_to_id: m.reply_to_id,
                }
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

  // 点别处 / 按 Esc 收起操作菜单。
  // ⋯ 按钮与菜单项自己 stopPropagation，否则「再点一次 ⋯ 收起」会被这里立刻又关掉。
  useEffect(() => {
    if (!menuFor) return
    const close = () => setMenuFor(null)
    const onKey = (e) => { if (e.key === 'Escape') setMenuFor(null) }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuFor])

  // 补拉本地没有的「被引用的原消息」
  const missingQuoteIds = useMemo(() => {
    const known = new Set(messages.map((m) => m.id))
    const need = messages
      .map((m) => m.reply_to_id)
      .filter((id) => id && !known.has(id) && !quotedCache[id])
    return [...new Set(need)]
  }, [messages, quotedCache])

  useEffect(() => {
    if (missingQuoteIds.length === 0) return
    let cancelled = false
    supabase
      .from('messages')
      .select('id, content, image_url, recalled_at, sender_id')
      .in('id', missingQuoteIds)
      .then(({ data }) => {
        if (cancelled || !data || data.length === 0) return
        setQuotedCache((prev) => {
          // 只有真的有新增才换引用，否则这个 effect 会自己触发自己，变成死循环
          let changed = false
          const next = { ...prev }
          for (const row of data) {
            if (!next[row.id]) { next[row.id] = row; changed = true }
          }
          return changed ? next : prev
        })
      })
    return () => { cancelled = true }
  }, [missingQuoteIds])

  // 只在新消息到达（末条变化）时贴底；向上加载历史时不要抢滚动位置
  const lastMessageId = messages[messages.length - 1]?.id
  useEffect(() => {
    const el = msgListRef.current
    if (!el || !lastMessageId) return
    el.scrollTop = el.scrollHeight
  }, [lastMessageId])

  // 输入框随内容长高。
  // 两个坑：
  //   1. 必须先把 height 归零再读 scrollHeight，否则内容变短时高度降不下来；
  //   2. scrollHeight **不含 border**，而本项目全局是 border-box，
  //      直接拿它当 height 会差 2px，导致常驻一条竖向滚动条 —— 所以把 border 补回去。
  // 高度上限写死在 CSS 的 max-height（见 .chat-input-row textarea），
  // 这样"多少行封顶"只有一个来源，不会两边各写一个数字然后漂移。
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const list = msgListRef.current
    // 输入框长高会挤掉消息区的高度。如果原本就贴着底部，就跟着保持贴底，
    // 否则用户正在看的最新消息会被顶出可视区。
    const wasAtBottom = list ? list.scrollHeight - list.scrollTop - list.clientHeight < 40 : false
    el.style.height = 'auto'
    const border = el.offsetHeight - el.clientHeight
    el.style.height = `${el.scrollHeight + border}px`
    if (list && wasAtBottom) list.scrollTop = list.scrollHeight
  }, [content])

  async function loadOlder() {
    if (loadingOlder || !hasMore) return
    const oldest = messages[0]?.created_at
    if (!oldest) return

    setLoadingOlder(true)
    const el = msgListRef.current
    // 记下插入前的高度与滚动位置，插入后把视口锚回原处，避免内容"跳走"
    const prevHeight = el?.scrollHeight ?? 0
    const prevTop = el?.scrollTop ?? 0

    const { data, error: olderError } = await supabase
      .from('messages')
      .select('*')
      .or(`and(sender_id.eq.${me},recipient_id.eq.${userId}),and(sender_id.eq.${userId},recipient_id.eq.${me})`)
      .order('created_at', { ascending: false })
      .lt('created_at', oldest)
      .limit(PAGE_SIZE)

    if (olderError) {
      setError(olderError.message)
    } else {
      const older = (data ?? []).slice().reverse()
      setMessages((prev) => [...older, ...prev])
      setHasMore((data?.length ?? 0) === PAGE_SIZE)
    }
    setLoadingOlder(false)

    requestAnimationFrame(() => {
      const node = msgListRef.current
      if (node) node.scrollTop = prevTop + (node.scrollHeight - prevHeight)
    })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if ((!content.trim() && !imageFile) || sending) return
    setSending(true)
    setError(null)
    try {
      let imageUrl = null
      if (imageFile) {
        const prepared = await compressImage(imageFile)
        const path = safeStorageKey(me, prepared.name)
        const { error: uploadError } = await supabase.storage
          .from('moment-images')
          .upload(path, prepared, { contentType: prepared.type })
        if (uploadError) throw uploadError
        const { data: publicUrlData } = supabase.storage
          .from('moment-images')
          .getPublicUrl(path)
        imageUrl = publicUrlData.publicUrl
      }
      const { error } = await supabase
        .from('messages')
        .insert({
          sender_id: me,
          recipient_id: userId,
          content: content.trim() || null,
          image_url: imageUrl,
          reply_to_id: replyTarget?.id ?? null,
        })
      if (error) throw error
      setContent('')
      setImageFile(null)
      setReplyTarget(null)
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
      const stamp = new Date().toISOString()
      // .select() 不能省：被 RLS / 触发器拦下的写**不报错**，只是影响 0 行
      // （PITFALLS #32 记的就是这个坑）
      const { data, error } = await supabase
        .from('messages')
        .update({ recalled_at: stamp, content: null, image_url: null })
        .eq('id', message.id)
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) throw new Error('撤回没有生效（可能已超过 2 分钟窗口）')
      setMessages((prev) =>
        prev.map((x) =>
          x.id === message.id
            ? { ...x, recalled_at: stamp, content: null, image_url: null }
            : x
        )
      )
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleSaveEdit() {
    if (!editing) return
    const next = editing.text.trim()
    if (!next) {
      setError('消息内容不能为空')
      return
    }
    setError(null)
    try {
      // edited_at 由服务端触发器写，这里不传（传了也会被覆盖）
      const { data, error } = await supabase
        .from('messages')
        .update({ content: next })
        .eq('id', editing.id)
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) throw new Error('编辑没有生效（可能已超过 2 分钟窗口）')
      const stamp = new Date().toISOString()
      setMessages((prev) =>
        prev.map((x) => (x.id === editing.id ? { ...x, content: next, edited_at: stamp } : x))
      )
      setEditing(null)
    } catch (err) {
      setError(err.message)
    }
  }

  /** 引用块要显示的原消息：优先用本地已加载的，其次是补拉回来的 */
  function resolveQuoted(m) {
    if (!m.reply_to_id) return null
    return (
      messages.find((x) => x.id === m.reply_to_id) ||
      quotedCache[m.reply_to_id] || { id: m.reply_to_id }
    )
  }

  function quotedPreview(q) {
    if (!q) return ''
    if (q.recalled_at) return '该消息已撤回'
    if (q.content) return q.content
    if (q.image_url) return '[图片]'
    return '（原消息不可用）'
  }

  function scrollToMessage(id) {
    const el = msgListRef.current?.querySelector(`[data-mid="${id}"]`)
    // 原消息可能是更早的一页，本地还没有——尽力而为地加载更早的历史
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    else loadOlder()
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
        {/* 头像点开看大图（灯箱），昵称点开看个人名片。两件事分开，
            因为"想看这个人是谁"和"想看这张图"是两种意图，混在一个点击上
            会让其中一种永远点不到。 */}
        <button
          type="button"
          className="chat-header-avatar"
          onClick={() => otherProfile?.avatar_url && setLightboxSrc(otherProfile.avatar_url)}
          aria-label={otherProfile?.avatar_url ? '查看头像大图' : '没有头像'}
        >
          {otherProfile?.avatar_url ? (
            <img src={otherProfile.avatar_url} alt="" />
          ) : (
            (otherProfile?.nickname ?? '').slice(0, 1)
          )}
        </button>
        <Link to={`/user/${userId}`} className="chat-header-name">
          {otherProfile?.nickname}
          <span className="chat-header-card-hint" aria-hidden="true">›</span>
        </Link>
      </div>

      <div className="chat-messages" ref={msgListRef}>
        {hasMore && (
          <div className="chat-load-older-row">
            <button type="button" className="chat-load-older-btn" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? '加载中…' : '加载更早的消息'}
            </button>
          </div>
        )}
        {rows.map(({ message: m, label, showLabel }, i) => {
          const isMine = m.sender_id === me
          const isRecalled = !!m.recalled_at
          const age = now - new Date(m.created_at).getTime()
          // 撤回 / 编辑都只在 2 分钟窗口内。编辑只针对纯文字——
          // 换图等于换了条消息，语义不对，所以带图的不给编辑入口。
          const canRecall = isMine && !isRecalled && age < RECALL_WINDOW_MS
          const canEdit = isMine && !isRecalled && !m.image_url && age < EDIT_WINDOW_MS
          const canQuote = !isRecalled
          const hasMenu = canRecall || canEdit || canQuote
          const isEditing = editing?.id === m.id
          const quoted = isRecalled ? null : resolveQuoted(m)
          // 最后一条贴着输入框，菜单往下弹会被滚动容器裁掉。
          // 而"刚发出去的消息"恰恰是最常要撤回/编辑的那条，所以它改成往上弹。
          const menuUp = i === rows.length - 1

          return (
            <div key={m.id} data-mid={m.id}>
              {showLabel && <div className="chat-time-label">{label}</div>}
              {isRecalled ? (
                <div className="chat-recalled-line">
                  {isMine ? '你撤回了一条消息' : '对方撤回了一条消息'}
                </div>
              ) : (
                <div className={`chat-bubble-row ${isMine ? 'mine' : 'theirs'}`}>
                  <div className={`chat-bubble ${isMine ? 'mine' : 'theirs'}`}>
                    {hasMenu && (
                      <div className="chat-msg-menu-wrap">
                        <button
                          type="button"
                          className="chat-msg-more"
                          aria-label="消息操作"
                          onClick={(e) => {
                            // 不 stopPropagation 的话，document 上那个"点别处收起"
                            // 会立刻把它关掉，表现为按钮点了没反应
                            e.stopPropagation()
                            setMenuFor(menuFor === m.id ? null : m.id)
                          }}
                        >
                          ⋯
                        </button>
                        {menuFor === m.id && (
                          <div
                            className={`chat-msg-menu${menuUp ? ' up' : ''}`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {canEdit && (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditing({ id: m.id, text: m.content ?? '' })
                                  setMenuFor(null)
                                }}
                              >
                                编辑
                              </button>
                            )}
                            {canQuote && (
                              <button
                                type="button"
                                onClick={() => {
                                  setReplyTarget(m)
                                  setMenuFor(null)
                                }}
                              >
                                引用
                              </button>
                            )}
                            {canRecall && (
                              <button
                                type="button"
                                className="danger"
                                onClick={() => {
                                  setMenuFor(null)
                                  handleRecall(m)
                                }}
                              >
                                撤回
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {quoted && (
                      <button
                        type="button"
                        className="chat-quote"
                        title="跳到原消息"
                        onClick={() => scrollToMessage(quoted.id)}
                      >
                        {quotedPreview(quoted)}
                      </button>
                    )}

                    {m.image_url && (
                      <a
                        href={m.image_url}
                        className="chat-bubble-image"
                        title="点开查看大图"
                        onClick={(e) => {
                          // Cmd / Ctrl / Shift + 点击照旧开新标签页，右键菜单也没被吃掉；
                          // 只接管普通左键，改成在当前页面里放大看
                          if (e.metaKey || e.ctrlKey || e.shiftKey) return
                          e.preventDefault()
                          setLightboxSrc(m.image_url)
                        }}
                      >
                        <img src={m.image_url} alt="" />
                      </a>
                    )}

                    {isEditing ? (
                      <div className="chat-edit">
                        <textarea
                          className="chat-edit-input"
                          value={editing.text}
                          rows={2}
                          maxLength={1000}
                          autoFocus
                          onChange={(e) => setEditing((s) => ({ ...s, text: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault()
                              handleSaveEdit()
                            }
                            if (e.key === 'Escape') setEditing(null)
                          }}
                        />
                        <div className="chat-edit-actions">
                          <button type="button" onClick={() => setEditing(null)}>取消</button>
                          <button type="button" className="primary" onClick={handleSaveEdit}>保存</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {m.content}
                        {m.edited_at && <span className="chat-edited-tag">已编辑</span>}
                      </>
                    )}

                    {isMine && (
                      <span className={`chat-read-status ${m.read_at ? 'read' : ''}`}>
                        {m.read_at ? '✓✓' : '✓'}
                      </span>
                    )}
                  </div>
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
          if (!el) return
          // 平滑滚动更好看，但开了「减少动态效果」的用户要立刻跳过去
          const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
          el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
        }} aria-label="回到底部">
          ↓
        </button>
      )}

      {error && <p className="error-text">{error}</p>}

      {replyTarget && (
        <div className="chat-reply-bar">
          <span className="chat-reply-bar-text">
            引用{replyTarget.sender_id === me ? '自己' : '对方'}：{quotedPreview(replyTarget)}
          </span>
          <button
            type="button"
            className="chat-reply-bar-cancel"
            onClick={() => setReplyTarget(null)}
            aria-label="取消引用"
          >
            ×
          </button>
        </div>
      )}

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
        <textarea
          ref={inputRef}
          className="chat-input-textarea"
          rows={1}
          placeholder="发消息…"
          title={isTouchPrimary ? '点右侧「发送」发送' : 'Enter 发送，Shift + Enter 换行'}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={1000}
          onKeyDown={(e) => {
            // 桌面端 Enter 直接发送；触屏端不拦，留给换行（见 isTouchPrimary 的说明）
            if (e.key === 'Enter' && !e.shiftKey && !isTouchPrimary) {
              e.preventDefault()
              handleSubmit(e)
            }
          }}
        />
        <button type="submit" disabled={sending || (!content.trim() && !imageFile)}>
          {sending ? '…' : '发送'}
        </button>
      </form>

      <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
    </div>
  )
}