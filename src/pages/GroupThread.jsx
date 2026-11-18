import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import { onUnlockChange } from '../lib/crypto'
import {
  decryptGroupRow, isPresenceFresh, listGroupThreads, loadGroupMessages,
  loadGroupPresence, markGroupSeen, recallGroupMessage, sendGroupMessage,
  subscribeGroupMessages,
} from '../lib/groupChat'

/**
 * 私密圈后花园（三人群聊：我 + 对方 + Ace）。
 *
 * 这个页面只做一件事：把 `group_messages` 里那些**加密行**解成能读的气泡。
 * 群密钥在本机（`group_keys` 里我那一份包裹 + 身份私钥解出来），页面从不显示密文。
 *
 * AI 的四个状态是"消息行"的一种（`kind:'ai_state'`），不是额外的浮层：
 * 好处是**刷新之后状态还在**、两台设备看到同一个状态，而且它天然排在时间线上。
 */

const RECALL_WINDOW_MS = 2 * 60 * 1000
const AI_STATE_TEXT = {
  thinking: '',
  working: '我正在查询相关代码',
  waiting: '等你说"执行"',
  offline: 'Ace 不在线',
}

function timeLabel(iso) {
  const d = new Date(iso)
  const now = new Date()
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (d.toDateString() === now.toDateString()) return hm
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`
  return `${d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })} ${hm}`
}

function initial(name) { return (name ?? '?').slice(0, 1) }

export default function GroupThread() {
  const session = useAuth()
  const me = session?.user?.id
  const [thread, setThread] = useState(null)
  const [messages, setMessages] = useState([])
  const [key, setKey] = useState(null)
  const [loading, setLoading] = useState(true)
  // 冷启动时"登录好了但钥匙还在派生"——解一次失败就等解锁事件再来一次，别让人对着"钥匙不在本机"发呆
  const [retryTick, setRetryTick] = useState(0)
  const [error, setError] = useState(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [replyTo, setReplyTo] = useState(null)
  const [menuFor, setMenuFor] = useState(null)
  const [atBottom, setAtBottom] = useState(true)
  const [aceOnline, setAceOnline] = useState(null)
  const [notice, setNotice] = useState(null)
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const keyRef = useRef(null)
  const threadRef = useRef(null)
  const bottomRef = useRef(true)

  const scrollToBottom = useCallback((smooth = false) => {
    const el = listRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  // ── 打开：拉群、解钥匙、解这一屏 ─────────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { threads, error: listErr } = await listGroupThreads()
      if (cancelled) return
      if (listErr) { setError(listErr); setLoading(false); return }
      const t = threads[0]
      if (!t) { setLoading(false); setThread(null); return }
      setThread(t)
      threadRef.current = t
      const res = await loadGroupMessages(t)
      if (cancelled) return
      keyRef.current = res.key
      setKey(res.key)
      setMessages(res.messages)
      setLoading(false)
      if (res.key) markGroupSeen(me, t.id)
      setError(res.error)
      requestAnimationFrame(() => scrollToBottom(false))
    })()
    return () => { cancelled = true }
  }, [me, scrollToBottom, retryTick])

  useEffect(() => {
    const off = onUnlockChange(() => setRetryTick((n) => n + 1))
    return off
  }, [])

  // ── 实时：新消息 / 状态更新 ─────────────────────────────────
  useEffect(() => {
    const t = threadRef.current
    if (!t || !keyRef.current) return undefined
    const off = subscribeGroupMessages(t.id, async (kind, row) => {
      const full = await decryptGroupRow(keyRef.current, row)
      if (!full) return
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === full.id)
        if (idx < 0) return [...prev, full]
        const next = prev.slice()
        next[idx] = { ...prev[idx], ...full }
        return next
      })
      if (bottomRef.current) requestAnimationFrame(() => scrollToBottom(false))
      if (kind === 'insert' && row.sender_id !== me) markGroupSeen(me, t.id)
    })
    return off
  }, [me, key, scrollToBottom])

  // ── 键盘：贴底（和私聊同一套行为）────────────────────────────
  useEffect(() => {
    if (loading) return undefined
    const bump = () => { if (bottomRef.current) scrollToBottom(false) }
    const raf = requestAnimationFrame(bump)
    const t1 = setTimeout(bump, 120)
    const t2 = setTimeout(bump, 400)
    return () => { cancelAnimationFrame(raf); clearTimeout(t1); clearTimeout(t2) }
  }, [loading, scrollToBottom])

  useEffect(() => {
    const onDoc = () => setMenuFor(null)
    document.addEventListener('click', onDoc)
    return () => document.removeEventListener('click', onDoc)
  }, [])

  // ── Ace 在不在线：读心跳（不在线时叫它就会白等，所以要看得见）─────
  useEffect(() => {
    const t = threadRef.current
    if (!t) return undefined
    const ace = (t.members ?? []).find((m) => m.is_ai)
    if (!ace) return undefined
    let stopped = false
    const tick = async () => {
      const presence = await loadGroupPresence(t.id)
      if (!stopped) setAceOnline(isPresenceFresh(presence[ace.id]))
    }
    tick()
    const timer = setInterval(tick, 45000)
    return () => { stopped = true; clearInterval(timer) }
  }, [thread])

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    bottomRef.current = near
    setAtBottom(near)
    if (near) markGroupSeen(me, threadRef.current?.id)
  }

  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages])
  const members = useMemo(() => {
    const map = new Map((thread?.members ?? []).map((m) => [m.id, m]))
    return map
  }, [thread])

  // 状态气泡：同一条行会被就地更新（thinking → working → 文字），所以列表里只有一个位置
  const rows = useMemo(() => messages.map((m, i) => {
    const prev = i > 0 ? timeLabel(messages[i - 1].created_at) : null
    const label = timeLabel(m.created_at)
    return { m, showLabel: label !== prev }
  }), [messages])

  const send = async (e) => {
    e?.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    const t = threadRef.current
    if (!t || !keyRef.current) { setError('这台设备还没拿到群钥匙，先退出重进一次'); return }
    setSending(true)
    setDraft('')
    const replyId = replyTo?.id ?? null
    setReplyTo(null)
    const res = await sendGroupMessage(t.id, keyRef.current, { kind: 'text', text }, replyId, me)
    // 叫了它、但它不在线 → 当场说一句，别让人对着"• • •"等
    if (aceOnline === false && /@\s*ace/i.test(text)) {
      setNotice('Ace 现在不在线（它的桥没在跑），等它回来再叫一次。')
      setTimeout(() => setNotice(null), 8000)
    }
    setSending(false)
    if (res.error) { setError(res.error); setDraft(text); return }
    // 乐观插入（实时那条回来时按 id 替换，不会重复）
    setMessages((prev) => prev.some((m) => m.id === res.row.id) ? prev : [...prev, { ...res.row, body: { kind: 'text', text } }])
    requestAnimationFrame(() => scrollToBottom(true))
  }

  const doRecall = async (id) => {
    setMenuFor(null)
    const res = await recallGroupMessage(id)
    if (res.error) { setError(res.error); return }
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, recalled_at: new Date().toISOString(), body: { kind: 'recalled' } } : m)))
  }

  if (loading) {
    return (
      <div className="chat-thread group-thread">
        <div className="chat-thread-header">
          <Link to="/chat" className="chat-back-btn">←</Link>
          <span className="chat-header-name">私密圈后花园</span>
        </div>
        <p className="status-text">打开中…</p>
      </div>
    )
  }

  if (!thread) {
    return (
      <div className="chat-thread group-thread">
        <div className="chat-thread-header">
          <Link to="/chat" className="chat-back-btn">←</Link>
          <span className="chat-header-name">私密圈后花园</span>
        </div>
        <p className="status-text">这个群还没有建立，或者你不在群里。</p>
      </div>
    )
  }

  return (
    <div className="chat-thread group-thread" data-group-thread={thread.id}>
      <div className="chat-thread-header">
        <Link to="/chat" className="chat-back-btn">←</Link>
        {/* 头像是"哪几个人"的三张小圆点 —— 但这三人本来就固定，占地方反而挤标题，
            所以只留标题 + 人数 + Ace 在不在（2026-11-18 截图后删掉）*/}
        <span className="chat-header-name group-header-name">
          {thread.name}
          <span className="group-header-count">{thread.memberCount} 人</span>
        </span>
        {aceOnline !== null && (
          <span className={`group-ace-status${aceOnline ? ' is-online' : ''}`} data-ace-online={aceOnline ? '1' : '0'}>
            <i aria-hidden="true" />
            Ace {aceOnline ? '在线' : '不在线'}
          </span>
        )}
      </div>

      {!key && (
        <button type="button" className="chat-unlock-bar" onClick={() => window.location.reload()}>
          这台设备还没拿到群钥匙，点这里重试（需要先登录解锁）
        </button>
      )}

      <div className="chat-messages group-messages" ref={listRef} onScroll={onScroll}>
        {rows.map(({ m, showLabel }) => {
          const isMine = m.sender_id === me
          const mine = members.get(m.sender_id)
          const body = m.body ?? { kind: 'locked' }
          const canRecall = isMine && body.kind !== 'recalled' && Date.now() - new Date(m.created_at).getTime() < RECALL_WINDOW_MS
          // 引用对**任何人的**文字消息都开放（只让引用自己的，等于半个功能）
          const canQuote = body.kind === 'text'
          const hasMenu = canRecall || canQuote
          const quoted = m.reply_to_id ? byId.get(m.reply_to_id) : null

          return (
            <div key={m.id} data-mid={m.id}>
              {showLabel && <div className="chat-time-label">{timeLabel(m.created_at)}</div>}

              {body.kind === 'recalled' ? (
                <div className="chat-recalled-line">{isMine ? '你撤回了一条消息' : `${mine?.nickname ?? '对方'}撤回了一条消息`}</div>
              ) : body.kind === 'ai_state' ? (
                <div className={`group-ai-state state-${body.state}`} data-ai-state={body.state}>
                  {body.state === 'thinking' ? (
                    <span className="group-ai-dots" aria-label="Ace 正在思考"><i /><i /><i /></span>
                  ) : (
                    <span>{AI_STATE_TEXT[body.state] ?? ''}</span>
                  )}
                </div>
              ) : (
                <div className={`chat-bubble-row ${isMine ? 'mine' : 'theirs'}${mine?.is_ai && !isMine ? ' from-ai' : ''}`}>
                  {!isMine && <span className={`group-sender-avatar${mine?.is_ai ? ' is-ai' : ''}`}>{initial(mine?.nickname)}</span>}
                  <div className={`chat-bubble ${isMine ? 'mine' : 'theirs'}`}>
                    {!isMine && (
                      <span className="group-sender-name">
                        {mine?.nickname ?? '成员'}
                        {mine?.is_ai && <span className="group-ai-badge">AI</span>}
                      </span>
                    )}
                    {quoted && (
                      <div className="chat-quote group-quote">
                        {quoted.body?.kind === 'text' ? (quoted.body.text ?? '').slice(0, 60) : '（一条消息）'}
                      </div>
                    )}
                    {body.kind === 'locked' ? (
                      <span className="chat-encrypted-hint">🔒 这条消息在这台设备上读不到</span>
                    ) : (
                      <span className="group-bubble-text">
                        {body.text}
                        {body.streaming ? <span className="group-stream-caret" aria-hidden="true" /> : null}
                      </span>
                    )}
                    {hasMenu && (
                      <div className="chat-msg-menu-wrap">
                        <button
                          type="button"
                          className="chat-msg-more"
                          aria-label="消息操作"
                          onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === m.id ? null : m.id) }}
                        >
                          ⋯
                        </button>
                        {menuFor === m.id && (
                          <div className={`chat-msg-menu${isMine ? ' align-right' : ''}`} role="menu">
                            {canQuote && (
                              <button type="button" role="menuitem" onClick={() => { setReplyTo(m); setMenuFor(null); inputRef.current?.focus() }}>引用</button>
                            )}
                            {canRecall && (
                              <button type="button" role="menuitem" className="danger" onClick={() => doRecall(m.id)}>撤回</button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}

        {messages.length === 0 && (
          <div className="group-empty">
            <p>这里只有你们三个人。</p>
            <p className="group-empty-hint">说一句「@Ace」叫它，说「@Ace 执行」它才会动手改代码。</p>
          </div>
        )}

        {!atBottom && (
          <button type="button" className="chat-scroll-btn" onClick={() => { bottomRef.current = true; setAtBottom(true); scrollToBottom(true) }}>
            ↓
          </button>
        )}
      </div>

      {notice && (
        <div className="group-notice" role="status" data-ace-offline-notice="1">{notice}</div>
      )}

      {error && (
        <div className="group-error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)} aria-label="关闭">×</button>
        </div>
      )}

      {replyTo && (
        <div className="chat-reply-bar">
          <span className="chat-reply-bar-text">引用：{(replyTo.body?.text ?? '').slice(0, 40)}</span>
          <button type="button" className="chat-reply-bar-cancel" onClick={() => setReplyTo(null)} aria-label="取消引用">×</button>
        </div>
      )}

      <form className="chat-input-row" onSubmit={send}>
        <textarea
          ref={inputRef}
          className="chat-input-textarea"
          rows={1}
          placeholder="说点什么…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={1000}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
              e.preventDefault()
              send(e)
            }
          }}
        />
        <button type="submit" disabled={sending || !draft.trim()}>{sending ? '…' : '发送'}</button>
      </form>
    </div>
  )
}
