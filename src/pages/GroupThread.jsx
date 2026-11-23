import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'
import SignedImage from '../components/SignedImage'
import BubbleAvatar from '../components/BubbleAvatar'
import BubbleMenu from '../components/BubbleMenu'
import GroupApprovalCard from '../components/GroupApprovalCard'
import useBubbleMenu from '../lib/useBubbleMenu'
import ImageLightbox from '../components/ImageLightbox'
import { resolveSignedUrl } from '../lib/signedUrls'
import { onUnlockChange } from '../lib/crypto'
import { usePinLatestOnViewport } from '../lib/usePinLatestOnViewport'
import ChatPaneSkeleton from '../components/ChatPaneSkeleton'
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
  const { wide = false } = useOutletContext() ?? {}
  const me = session?.user?.id
  const [thread, setThread] = useState(null)
  const [messages, setMessages] = useState([])
  const [key, setKey] = useState(null)
  const [loading, setLoading] = useState(true)
  // 冷启动时"登录好了但钥匙还在派生"——解一次失败就等解锁事件再来一次，别让人对着"钥匙不在本机"发呆
  const [retryTick, setRetryTick] = useState(0)
  const [error, setError] = useState(null)
  const [draft, setDraft] = useState('')
  // 「通过/不通过」点了之后先在本机记下（桥会把卡片那条消息改写成 approved/rejected）
  const [approvalAnswers, setApprovalAnswers] = useState({})
  const [sending, setSending] = useState(false)
  const [replyTo, setReplyTo] = useState(null)
  // 气泡操作菜单：右键 / 触屏长按打开，菜单渲染在气泡内部（见 BubbleMenu）
  const { openId: menuFor, bubbleMenuProps, closeMenu } = useBubbleMenu()
  const [atBottom, setAtBottom] = useState(true)
  const [aceOnline, setAceOnline] = useState(null)
  const [notice, setNotice] = useState(null)
  // 点气泡旁的小头像看大图（复用私聊/动态同一个灯箱）
  const [lightboxSrc, setLightboxSrc] = useState(null)
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

  // 手机键盘弹起时贴底 —— 与私聊（ChatThread）同一套 hook、同一套阈值。
  // 宽屏三栏右栏不启用（enabled=!wide），键盘 hack 只属于手机形态。
  usePinLatestOnViewport({ enabled: !wide, listRef, onPin: scrollToBottom, rerunKey: loading })

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

  // 「Ace 不在线」不再作为消息显示：顶部实时状态已经说明了。
  // 旧数据里的那几条 offline 行留在服务器（不改历史），只是不渲染。
  const visible = useMemo(
    () => messages.filter((m) => {
      if (m.body?.kind === 'ai_state' && m.body.state === 'offline') return false
      // 「通过/不通过」是**操作凭据**（给桥看的），不是聊天内容：卡片本身会显示结果，
      // 列表里再冒一条空气泡只会让人以为"我发了一条空消息"。
      if (m.body?.kind === 'approval_answer') return false
      return true
    }),
    [messages],
  )
  const byId = useMemo(() => new Map(visible.map((m) => [m.id, m])), [visible])
  const members = useMemo(() => {
    const map = new Map((thread?.members ?? []).map((m) => [m.id, m]))
    return map
  }, [thread])

  // 状态气泡：同一条行会被就地更新（thinking → working → 文字），所以列表里只有一个位置
  const rows = useMemo(() => visible.map((m, i) => {
    const prev = i > 0 ? timeLabel(visible[i - 1].created_at) : null
    const label = timeLabel(m.created_at)
    return { m, showLabel: label !== prev }
  }), [visible])

  // 点谁的头像就在输入框里插入 @谁（并聚焦、光标放到最后）
  const mention = (member) => {
    const token = `@${member.nickname} `
    const el = inputRef.current
    const start = el?.selectionStart ?? draft.length
    const end = el?.selectionEnd ?? draft.length
    const next = `${draft.slice(0, start)}${token}${draft.slice(end)}`
    setDraft(next.slice(0, 1000))
    requestAnimationFrame(() => {
      el?.focus()
      const pos = Math.min(next.length, 1000)
      try { el?.setSelectionRange(pos, pos) } catch { /* 老浏览器 */ }
    })
  }

  const others = useMemo(() => (thread?.members ?? []).filter((m) => m.id !== me), [thread, me])
  // 只有建群人（i4）能点「通过」；服务端另有校验（桥只认 i4 的 sender_id）
  const canDecide = !!thread?.created_by && thread.created_by === me

  // 点「通过/不通过」：往群里写一条 approval_answer（自己那一行），桥收到后决定要不要开工
  const answerApproval = async (body, approve) => {
    const t = threadRef.current
    if (!t || !keyRef.current) throw new Error('这台设备还没拿到群钥匙，先退出重进一次')
    const res = await sendGroupMessage(t.id, keyRef.current, {
      kind: 'approval_answer', approvalId: body.approvalId, approve,
    }, null, me)
    if (res.error) throw new Error(res.error)
    setApprovalAnswers((prev) => ({ ...prev, [body.approvalId]: approve ? 'approved' : 'rejected' }))
  }

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
    const res = await recallGroupMessage(id)
    if (res.error) { setError(res.error); return }
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, recalled_at: new Date().toISOString(), body: { kind: 'recalled' } } : m)))
  }

  if (loading) {
    // 宽屏右栏与私聊用同一个会话骨架（同高、非单行文本）
    if (wide) return <ChatPaneSkeleton pane label="正在打开群聊" />
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
          {!wide && <Link to="/chat" className="chat-back-btn">←</Link>}
          <span className="chat-header-name">私密圈后花园</span>
        </div>
        <p className="status-text">这个群还没有建立，或者你不在群里。</p>
      </div>
    )
  }

  return (
    <div
      className={`chat-thread group-thread${wide ? ' chat-thread--pane' : ''}`}
      data-group-thread={thread.id}
      data-keyboard-pin={wide ? 'off' : 'on'}
    >
      <div className="chat-thread-header">
        {!wide && <Link to="/chat" className="chat-back-btn">←</Link>}
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
                // AI 的状态也走"左边的气泡"：头像 + 对话框，和它正常说话时同一个位置。
                // 2026-11-19 使用者："把状态放到正中间很离谱，应该像左边一个对话框。"
                <div className={`chat-bubble-row theirs from-ai group-ai-state-row state-${body.state}`} data-ai-state={body.state}>
                  <span className="group-sender-avatar is-ai">
                    {mine?.avatar_url
                      ? <SignedImage bucket="avatars" stored={mine.avatar_url} alt="" />
                      : initial(mine?.nickname)}
                  </span>
                  <div className="chat-bubble theirs group-ai-state-bubble">
                    <span className="group-sender-name">
                      {mine?.nickname ?? 'Ace'}
                      <span className="group-ai-badge">AI</span>
                    </span>
                    {body.state === 'thinking' ? (
                      <span className="group-thinking">
                        <span className="group-thinking-text">思考中</span>
                        <span className="group-ai-dots" aria-label="Ace 正在思考"><i /><i /><i /></span>
                      </span>
                    ) : (
                      <span className="group-ai-state-text">{AI_STATE_TEXT[body.state] ?? ''}</span>
                    )}
                  </div>
                </div>
              ) : body.kind === 'approval' ? (
                // 确认卡片：放在 Ace 那一侧（它就是 Ace 提的请求），头像/名字与它说话时一致
                <div className="chat-bubble-row theirs from-ai group-approval-row">
                  <span className="group-sender-avatar is-ai">
                    {mine?.avatar_url
                      ? <SignedImage bucket="avatars" stored={mine.avatar_url} alt="" />
                      : initial(mine?.nickname)}
                  </span>
                  <GroupApprovalCard
                    body={body}
                    canDecide={canDecide}
                    answered={approvalAnswers[body.approvalId]}
                    onAnswer={(approve) => answerApproval(body, approve)}
                    nickname={mine?.nickname ?? 'Ace'}
                  />
                </div>
              ) : (
                <div className={`chat-bubble-row ${isMine ? 'mine' : 'theirs'}${mine?.is_ai && !isMine ? ' from-ai' : ''}`}>
                  {!isMine && (
                    <BubbleAvatar
                      className={`group-sender-avatar${mine?.is_ai ? ' is-ai' : ''}`}
                      stored={mine?.avatar_url}
                      nickname={mine?.nickname}
                      side="theirs"
                      label={mine?.is_ai ? 'Ace 头像' : '对方头像'}
                      onOpen={async () => {
                        const url = await resolveSignedUrl('avatars', mine?.avatar_url)
                        if (url) setLightboxSrc(url)
                      }}
                    />
                  )}
                  <div
                    className={`chat-bubble ${isMine ? 'mine' : 'theirs'}`}
                    onContextMenu={(e) => e.preventDefault()}
                    {...(hasMenu ? bubbleMenuProps(m.id) : {})}
                  >
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
                    {hasMenu && menuFor === m.id && (
                      <div className="chat-msg-menu-wrap">
                        <BubbleMenu
                          isMine={isMine}
                          label="消息操作"
                          onClose={closeMenu}
                          items={[
                            ...(canQuote ? [{
                              key: 'quote',
                              label: '引用',
                              onSelect: () => { setReplyTo(m); inputRef.current?.focus() },
                            }] : []),
                            ...(canRecall ? [{
                              key: 'recall',
                              label: '撤回',
                              danger: true,
                              onSelect: () => doRecall(m.id),
                            }] : []),
                          ]}
                        />
                      </div>
                    )}
                  </div>
                  {isMine && (
                    <BubbleAvatar
                      className="group-sender-avatar"
                      stored={mine?.avatar_url}
                      nickname={mine?.nickname ?? session?.user?.email}
                      side="mine"
                      label="我的头像"
                      onOpen={async () => {
                        const url = await resolveSignedUrl('avatars', mine?.avatar_url)
                        if (url) setLightboxSrc(url)
                      }}
                    />
                  )}
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

      {/* 输入框上方：点谁的头像就 @谁。群里"这句话是说给谁听的"必须一眼能选，
          不然只能靠手打 @，还得记住昵称（2026-11-19 使用者反馈） */}
      {others.length > 0 && (
        <div className="group-mention-bar" role="group" aria-label="艾特谁">
          <span className="group-mention-hint">艾特</span>
          {others.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`group-mention-chip${m.is_ai ? ' is-ai' : ''}`}
              onClick={() => mention(m)}
              title={`插入 @${m.nickname}`}
              data-mention={m.is_ai ? 'ai' : 'human'}
            >
              <span className="group-mention-avatar">
                {m.avatar_url
                  ? <SignedImage bucket="avatars" stored={m.avatar_url} alt="" />
                  : initial(m.nickname)}
              </span>
              <span className="group-mention-name">{m.nickname}</span>
            </button>
          ))}
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

      <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
    </div>
  )
}
