import { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import SignedImage from '../components/SignedImage'
import { prefetchThread, readChatListSnapshot, writeChatListSnapshot } from '../lib/chatCache'
import { subscribeChatLive } from '../lib/chatLive'
import { decryptForPeer } from '../lib/crypto'
import {
  decryptGroupRow, groupKeyFor, loadGroupSummaries, loadGroupSummary, readGroupSnapshot,
} from '../lib/groupChat'
import { stickerIdFromContent } from '../lib/stickers'

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

function previewFromText(text) {
  const isVideo = typeof text === 'string' && text.startsWith('{"v":1,"kind":"video"')
  const fileEnvelope = typeof text === 'string' && text.startsWith('{"v":1,"kind":"file"')
  return {
    // 表情/文件消息在列表里只显示「[表情]」「[文件]」（不把内部标记露给使用者）
    lastMsg: stickerIdFromContent(text)
      ? '[表情]'
      : (isVideo ? '[视频]' : (fileEnvelope ? '[文件]' : text)),
    lastFile: fileEnvelope,
    lastVideo: isVideo,
  }
}

/**
 * 把"最后一条消息"变成侧栏要显示的几个字段。
 * 全量加载与 Realtime 单行刷新共用，避免两条路径的预览规则漂移。
 */
async function previewForMessage(partnerId, last, knownText = null) {
  if (!last) {
    return {
      lastMsg: null,
      lastImage: null,
      lastFile: false,
      lastVideo: false,
      lastRecalled: false,
      lastTime: null,
    }
  }
  const base = {
    lastImage: last.image_url ?? null,
    lastRecalled: !!last.recalled_at,
    lastTime: last.created_at ?? null,
  }
  if (!last.ciphertext || !last.iv) {
    return { ...base, lastMsg: last.content ?? null, lastFile: false, lastVideo: false }
  }
  try {
    // Realtime INSERT 已经为"先打一帧"解过一次密；定向查询拿到同一条消息时
    // 把明文传进来，避免同一条密文在 120ms 内被解两次（见 refreshConversation）。
    const text = knownText ?? await decryptForPeer(partnerId, last)
    return { ...base, ...previewFromText(text) }
  } catch {
    // 解不开就不显示内容，也绝不显示乱码
    return { ...base, lastMsg: '🔒 消息', lastFile: false, lastVideo: false }
  }
}

function conversationTime(c) {
  return c.lastTime ? new Date(c.lastTime).getTime() : 0
}

export default function ChatList({
  // 宽屏三栏时作为第二列常驻；窄屏保持原来的整页列表。
  embedded = false,
  activeId = null,
  activeGroup = false,
  // 常驻侧栏（桌面三栏）才开 Realtime：窄屏列表只是一次性页面，订阅纯浪费连接
  live = false,
} = {}) {
  const session = useAuth()
  const me = session.user.id
  const [conversations, setConversations] = useState([])
  const [groups, setGroups] = useState([])
  // 群那一行**从第一帧就要在**：没有快照时先画一个占位行，解密完再填内容
  const [groupLoading, setGroupLoading] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // 群摘要失败只影响群行内容，不能把私聊列表整页变成错误页
  const [groupNotice, setGroupNotice] = useState(null)
  const [retryTick, setRetryTick] = useState(0)
  const [search, setSearch] = useState('')
  const groupsRef = useRef([])
  const activeRowRef = useRef(null)
  const pendingActiveScrollRef = useRef(false)
  // partnerId → { id, ciphertext, iv, text }：给 Realtime 与定向查询共用一份解密结果。
  const decryptedPreviewRef = useRef(new Map())

  // 只有 activeId/activeGroup 变化或目标行刚渲染出来时才滚动一次。
  // 这样使用者自己把列表滚走之后，后续 Realtime 更新不会把选中行硬拉回来。
  useEffect(() => {
    pendingActiveScrollRef.current = true
  }, [activeId, activeGroup])

  useEffect(() => {
    if (!pendingActiveScrollRef.current) return
    const row = activeRowRef.current
    if (!row) return
    if (!row.isConnected) {
      activeRowRef.current = null
      return
    }
    const scroller = row.closest('.chat-page--pane')
    if (!scroller) return
    // 只调容器的 scrollTop，不调用 focus()/click()：
    // 深链或刷新时滚动选中行，不能抢走键盘焦点，也不能触发额外的已读写入。
    const raf = window.requestAnimationFrame(() => {
      const rowRect = row.getBoundingClientRect()
      const boxRect = scroller.getBoundingClientRect()
      const searchEl = scroller.querySelector('.chat-search')
      const stickyBottom = searchEl ? searchEl.getBoundingClientRect().bottom : boxRect.top
      const visibleTop = Math.max(boxRect.top, stickyBottom) + 2
      const visibleBottom = boxRect.bottom - 2
      if (rowRect.top < visibleTop) {
        scroller.scrollTop -= visibleTop - rowRect.top
      } else if (rowRect.bottom > visibleBottom) {
        scroller.scrollTop += rowRect.bottom - visibleBottom
      }
      pendingActiveScrollRef.current = false
    })
    return () => window.cancelAnimationFrame(raf)
    // conversations/groups 变化会让"目标行第一次出现"这一帧也跑到这里；
    // search 只用于过滤后重新出现时补一次，不参与"把滚走的行拉回来"。
  }, [activeId, activeGroup, conversations, groups, search])

  const setActiveRowRef = useCallback((node) => {
    activeRowRef.current = node
  }, [])

  // 先用上次的快照把联系人画出来（见 lib/chatCache.js）。
  // ⚠️ useLayoutEffect：要在**第一帧之前**就把内容放进去，否则先闪一下"加载中"。
  useLayoutEffect(() => {
    const uid = session?.user?.id
    if (!uid) return
    // 私聊和群聊**都要第一帧就在**：群入口用本机快照先画出来，解密结果随后覆盖
    const cached = readChatListSnapshot(uid)
    if (cached) setConversations((prev) => (prev.length > 0 ? prev : cached))
    const cachedGroups = readGroupSnapshot(uid)
    if (cachedGroups?.summaries) setGroups((prev) => (prev.length > 0 ? prev : cachedGroups.summaries))
    if (cached || cachedGroups?.summaries) setLoading(false)
  }, [session?.user?.id])

  useEffect(() => { groupsRef.current = groups }, [groups])

  // 群摘要刷新（初次、重试、Realtime 共用）。失败时**只提示、不清空**：
  // 三栏的群行要一直挂着，不能因为一次解密/网络失败就让入口消失。
  const refreshGroupSummaries = useCallback(async () => {
    try {
      const gs = await loadGroupSummaries(me)
      if (gs?.error) {
        setGroupNotice('群消息摘要暂时没更新，稍后会自动重试')
        return
      }
      if (gs?.summaries?.length) {
        setGroups(gs.summaries)
        setGroupNotice(null)
        return
      }
      if (groupsRef.current.length > 0) setGroupNotice('群消息摘要暂时没更新，稍后会自动重试')
    } catch {
      setGroupNotice('群消息摘要暂时没更新，稍后会自动重试')
    }
  }, [me])

  // 已读回传：会话页写完 read_at / markGroupSeen 后，侧栏本地立即清零。
  // 这里只是"界面提示"，下一次 Realtime 全量校正会以数据库为准。
  useEffect(() => {
    return subscribeChatLive((event) => {
      if (event.type === 'conversation-read') {
        setConversations((prev) => {
          let changed = false
          const next = prev.map((c) => {
            if (c.id !== event.peerId || c.unread === 0) return c
            changed = true
            return { ...c, unread: 0 }
          })
          return changed ? next : prev
        })
      } else if (event.type === 'group-seen') {
        setGroups((prev) => {
          let changed = false
          const next = prev.map((g) => {
            if (g.thread?.id !== event.threadId || g.unread === 0) return g
            changed = true
            return { ...g, unread: 0 }
          })
          return changed ? next : prev
        })
      }
    })
  }, [])

  // 侧栏常驻时把最新状态写回快照，换页/刷新第一帧不会又看到旧的未读数。
  useEffect(() => {
    if (!embedded || loading || conversations.length === 0) return
    writeChatListSnapshot(me, conversations)
  }, [conversations, embedded, loading, me])

  useEffect(() => {
    async function load() {
      try {
        setError(null)
        // 群摘要**不跟着联系人一起等**：它自己解密，先到先填；失败了也只是少一行，
        // 并保留第一帧已经画出来的本机快照（群加载失败不影响 1:1 列表）。
        refreshGroupSummaries().finally(() => setGroupLoading(false))

        const [profileRes, msgRes, unreadRes] = await Promise.all([
          supabase.from('profiles').select('id, nickname, avatar_url, is_ai').neq('id', me),
          supabase
            .from('messages')
            .select('sender_id, recipient_id, content, ciphertext, iv, created_at, read_at, image_url, recalled_at')
            .or(`sender_id.eq.${me},recipient_id.eq.${me}`)
            .order('created_at', { ascending: false })
            .limit(500),
          supabase
            .from('messages')
            .select('sender_id')
            .eq('recipient_id', me)
            .is('read_at', null)
            .is('recalled_at', null),
        ])
        // 三个数据源任一失败都要让使用者看见，同时仍把已经拿到的部分画出来
        const queryError = profileRes.error || msgRes.error || unreadRes.error
        if (queryError) setError(queryError.message)
        if (!profileRes.error) {
          const unreadCounts = {}
          for (const m of (unreadRes.data || [])) {
            unreadCounts[m.sender_id] = (unreadCounts[m.sender_id] || 0) + 1
          }

          const latestByPartner = {}
          for (const m of (msgRes.data || [])) {
            const partnerId = m.sender_id === me ? m.recipient_id : m.sender_id
            if (!latestByPartner[partnerId]) {
              latestByPartner[partnerId] = {
                content: m.content,
                ciphertext: m.ciphertext,
                iv: m.iv,
                created_at: m.created_at,
                image_url: m.image_url,
                recalled_at: m.recalled_at,
              }
            }
          }

          // 最后一条是密文时，解出预览（解不开就不显示预览，绝不显示乱码）。
          // 全量加载与 Realtime 单行刷新共用 previewForMessage，规则不会漂移。
          // AI 成员（Ace）不进 1:1 列表：它住在「私密圈后花园」那个群里，
          // 这里再出现一个"Ace 私聊"只会让人以为有两个入口。
          const humans = (profileRes.data ?? []).filter((p) => !p.is_ai)
          const merged = await Promise.all(humans.map(async (p) => ({
            ...p,
            ...await previewForMessage(p.id, latestByPartner[p.id]),
            unread: unreadCounts[p.id] || 0,
          })))

          merged.sort((a, b) => conversationTime(b) - conversationTime(a))

          setConversations(merged)
          writeChatListSnapshot(me, merged)
        }
      } catch (err) {
        // 网络被拦断时 supabase-js 会抛异常（参考 Timeline 的既有修法）
        setError(err?.message || '网络请求失败')
      } finally {
        // 无论成功/失败都要落回 false，否则整页永远停在"加载中…"
        setLoading(false)
      }
    }
    load()
  }, [me, retryTick, refreshGroupSummaries])

  // ── 常驻侧栏的 Realtime：只刷新受影响的那一行 ─────────────────────
  // 不做"每条消息都重新拉 500 条 + 重新解密 50 个会话"：
  //   · 私聊：按对方 id 合并 120ms 内的连续事件，只查"我与他最近 1 条 + 未读数"；
  //   · 群聊：只解密这一条 + 只重算这个群的 40 条摘要，合并 120ms；
  //   · 失败一律保留旧行（群摘要失败会由 refreshGroupSummaries 给轻提示）。
  useEffect(() => {
    if (!live || !embedded) return undefined
    let cancelled = false
    const convTimers = new Map()
    const convSeq = new Map()
    let groupTimer = null
    const groupThreadIds = new Set()

    // 新消息先按 Realtime 载荷本地打一帧（未读/排序立刻动），随后 120ms 的
    // 定向查询再以数据库为准校正。这样不依赖"查询往返"完成才开始更新界面。
    function applyInsert(m) {
      const partnerId = m.sender_id === me ? m.recipient_id : m.sender_id
      if (!partnerId || partnerId === me) return
      const incoming = m.recipient_id === me
      const plainPreview = (!m.ciphertext && !m.recalled_at) ? previewFromText(m.content ?? '') : null
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === partnerId)
        if (idx < 0) return prev
        const next = prev.slice()
        next[idx] = {
          ...next[idx],
          ...(plainPreview ?? {}),
          lastMsg: plainPreview ? plainPreview.lastMsg : next[idx].lastMsg,
          lastImage: m.image_url ?? next[idx].lastImage,
          lastRecalled: false,
          lastTime: m.created_at ?? next[idx].lastTime,
          unread: (next[idx].unread || 0) + (incoming ? 1 : 0),
        }
        next.sort((a, b) => conversationTime(b) - conversationTime(a))
        return next
      })
      if (plainPreview) return
      decryptForPeer(partnerId, m).then((text) => {
        if (cancelled) return
        // 定向查询马上会拿到同一条消息；把这次解出的明文留一份，
        // 用 id + 密文 + iv 校验后复用，避免同一条消息在 120ms 内解两遍。
        if (m.id) {
          decryptedPreviewRef.current.set(partnerId, {
            id: m.id, ciphertext: m.ciphertext ?? null, iv: m.iv ?? null, text,
          })
        }
        const preview = previewFromText(text)
        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.id === partnerId)
          if (idx < 0) return prev
          const next = prev.slice()
          next[idx] = { ...next[idx], ...preview }
          return next
        })
      }).catch(() => { /* 解不开保留旧预览，定向查询会按「🔒 消息」校正 */ })
    }

    async function refreshConversation(partnerId) {
      if (!partnerId || partnerId === me) return
      const seq = (convSeq.get(partnerId) ?? 0) + 1
      convSeq.set(partnerId, seq)
      const [latestRes, unreadRes] = await Promise.all([
        supabase
          .from('messages')
          .select('id, sender_id, recipient_id, content, ciphertext, iv, created_at, image_url, recalled_at')
          .or(`and(sender_id.eq.${me},recipient_id.eq.${partnerId}),and(sender_id.eq.${partnerId},recipient_id.eq.${me})`)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('sender_id', partnerId)
          .eq('recipient_id', me)
          .is('read_at', null)
          .is('recalled_at', null),
      ])
      // 同一个人的请求可能乱序返回（A→B→A）；只认最后一次
      if (cancelled || convSeq.get(partnerId) !== seq) return
      if (latestRes.error || unreadRes.error) return
      const latest = latestRes.data
      const cachedDecrypt = decryptedPreviewRef.current.get(partnerId)
      const sameMessage = !!latest && !!cachedDecrypt &&
        cachedDecrypt.id === latest.id &&
        cachedDecrypt.ciphertext === (latest.ciphertext ?? null) &&
        cachedDecrypt.iv === (latest.iv ?? null)
      if (sameMessage) decryptedPreviewRef.current.delete(partnerId)
      const preview = await previewForMessage(
        partnerId,
        latest,
        sameMessage ? cachedDecrypt.text : null,
      )
      if (cancelled || convSeq.get(partnerId) !== seq) return
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === partnerId)
        if (idx < 0) return prev
        const next = prev.slice()
        next[idx] = { ...next[idx], ...preview, unread: unreadRes.count || 0 }
        next.sort((a, b) => conversationTime(b) - conversationTime(a))
        return next
      })
    }

    function scheduleConversation(partnerId) {
      if (!partnerId) return
      clearTimeout(convTimers.get(partnerId))
      convTimers.set(partnerId, setTimeout(() => {
        convTimers.delete(partnerId)
        refreshConversation(partnerId)
      }, 120))
    }

    // 群消息实时到达：先解密这一条本地打帧，再只重算这个群的摘要。
    // 不能走 loadGroupSummaries（那会重新列群/拉成员 + 所有群各解 40 条），
    // 一个群的消息不该让整列摘要重算 —— 实测会把 1 秒拖到 3 秒。
    async function applyGroupInsert(m) {
      const group = groupsRef.current.find((g) => g.thread?.id === m.thread_id)
      if (!group?.thread) return
      try {
        const key = await groupKeyFor(group.thread)
        const full = await decryptGroupRow(key, m)
        if (cancelled || !full) return
        const incoming = m.sender_id !== me
        const countsAsUnread = incoming && full.body?.kind !== 'ai_state' && full.body?.kind !== 'locked'
        setGroups((prev) => {
          const idx = prev.findIndex((g) => g.thread?.id === m.thread_id)
          if (idx < 0) return prev
          const next = prev.slice()
          next[idx] = {
            ...next[idx],
            latest: full.body?.kind ? { body: full.body, created_at: full.created_at, sender_id: full.sender_id } : next[idx].latest,
            lastTime: full.created_at ?? next[idx].lastTime,
            unread: (next[idx].unread || 0) + (countsAsUnread ? 1 : 0),
          }
          return next
        })
      } catch { /* 定向重算会兜底 */ }
    }

    async function refreshGroupRow(threadId) {
      const group = groupsRef.current.find((g) => g.thread?.id === threadId)
      if (!group?.thread) {
        refreshGroupSummaries()
        return
      }
      const { summary, error } = await loadGroupSummary(group.thread, me)
      if (cancelled) return
      if (error || !summary) {
        setGroupNotice('群消息摘要暂时没更新，稍后会自动重试')
        return
      }
      setGroups((prev) => {
        const idx = prev.findIndex((g) => g.thread?.id === threadId)
        if (idx < 0) return prev
        const next = prev.slice()
        next[idx] = { ...next[idx], ...summary }
        return next
      })
      setGroupNotice(null)
    }

    function scheduleGroups(threadId = null) {
      if (threadId) groupThreadIds.add(threadId)
      clearTimeout(groupTimer)
      groupTimer = setTimeout(() => {
        const ids = [...groupThreadIds]
        groupThreadIds.clear()
        if (ids.length) {
          for (const id of ids) refreshGroupRow(id)
        } else {
          refreshGroupSummaries()
        }
      }, 120)
    }

    const channel = supabase
      .channel(`chat-list-live-${me}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new
        if (!m || (m.sender_id !== me && m.recipient_id !== me)) return
        applyInsert(m)
        scheduleConversation(m.sender_id === me ? m.recipient_id : m.sender_id)
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new
        if (!m || (m.sender_id !== me && m.recipient_id !== me)) return
        scheduleConversation(m.sender_id === me ? m.recipient_id : m.sender_id)
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'group_messages' }, (payload) => {
        const m = payload.new
        if (!m) return
        applyGroupInsert(m)
        scheduleGroups(m.thread_id)
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'group_messages' }, (payload) => {
        scheduleGroups(payload.new?.thread_id)
      })
      .subscribe()

    return () => {
      cancelled = true
      for (const timer of convTimers.values()) clearTimeout(timer)
      convTimers.clear()
      clearTimeout(groupTimer)
      supabase.removeChannel(channel)
    }
  }, [live, embedded, me, refreshGroupSummaries])

  const filtered = useMemo(() => {
    if (!search.trim()) return conversations
    const q = search.toLowerCase()
    return conversations.filter((c) => c.nickname.toLowerCase().includes(q))
  }, [conversations, search])

  // 群聊行也吃搜索：按群名过滤（群里就一个，但别让搜索框装作没看见它）
  const shownGroups = useMemo(() => {
    if (!search.trim()) return groups
    const q = search.toLowerCase()
    return groups.filter((g) => (g.thread?.name ?? '').toLowerCase().includes(q))
  }, [groups, search])

  function retryLoad() {
    setLoading(true)
    setRetryTick((n) => n + 1)
  }

  function retryGroups() {
    setGroupLoading(true)
    refreshGroupSummaries().finally(() => setGroupLoading(false))
  }

  // 已有快照/旧行时不要把列表换成整页"加载中…"（常驻侧栏闪一下就是一次跳动）
  if (loading && conversations.length === 0 && groups.length === 0) {
    return <p className="status-text">加载中…</p>
  }

  return (
    <div className={`chat-page${embedded ? ' chat-page--pane' : ''}`}>
      {error && (
        <div className="status-text" role="alert">
          <p className="error-text">加载失败：{error}</p>
          <button className="maint-retry" type="button" onClick={retryLoad}>
            重试
          </button>
        </div>
      )}
      <div className="chat-search" role="search">
        <input
          type="text"
          aria-label="搜索联系人"
          placeholder="搜索联系人…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {groupNotice && (
        <div className="chat-list-notice" role="status" data-group-notice="1">
          <span>{groupNotice}</span>
          <button type="button" onClick={retryGroups}>重试</button>
        </div>
      )}
      {(shownGroups.length > 0 || groupLoading) && (
        <ul className="chat-list chat-group-list">
          {shownGroups.length === 0 && groupLoading && (
            <li>
              <span className="chat-list-item chat-group-item is-placeholder" aria-hidden="true">
                <span className="chat-list-avatar chat-group-avatar"><span className="chat-group-avatar-glyph">❀</span></span>
                <span className="chat-list-info">
                  <span className="chat-list-name">私密圈后花园<span className="chat-group-count">3 人</span></span>
                  <span className="chat-list-preview">正在打开…</span>
                </span>
                <span className="chat-list-time" />
              </span>
            </li>
          )}
          {shownGroups.map(({ thread: g, latest, unread, lastTime }) => (
            <li key={g.id}>
              <Link
                to="/garden"
                className={`chat-list-item chat-group-item${activeGroup ? ' is-active' : ''}`}
                aria-current={activeGroup ? 'page' : undefined}
                data-group-id={g.id}
                ref={activeGroup ? setActiveRowRef : undefined}
              >
                <span className="chat-list-avatar chat-group-avatar" aria-hidden="true">
                  <span className="chat-group-avatar-glyph">❀</span>
                </span>
                <span className="chat-list-info">
                  <span className="chat-list-name">
                    {g.name}
                    <span className="chat-group-count">{g.memberCount} 人</span>
                    {unread > 0 && <span className="chat-unread-badge">{unread > 99 ? '99+' : unread}</span>}
                  </span>
                  <span className="chat-list-preview">
                    {latest
                      ? (latest.body?.kind === 'text'
                        ? truncate(latest.body.text ?? '')
                        : (latest.body?.kind === 'locked' ? '🔒 消息' : '[已撤回]'))
                      : '还没有消息'}
                  </span>
                </span>
                <span className="chat-list-time">{formatChatTime(lastTime)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {filtered.length === 0 ? (
        !error && <p className="status-text">还没有聊天记录。</p>
      ) : (
        <ul className="chat-list">
          {filtered.map((c) => (
            <li
              key={c.id}
              // 悬停（桌面）或手指按下（触屏）就开始拉这个会话：
              // 等人真的点进去时，通常已经拿到了 → 那一次"加载中"就看不到了。
              onMouseEnter={() => prefetchThread(session?.user?.id, c.id)}
              onTouchStart={() => prefetchThread(session?.user?.id, c.id)}
            >
              <Link
                to={`/chat/${c.id}`}
                className={`chat-list-item${activeId === c.id ? ' is-active' : ''}`}
                aria-current={activeId === c.id ? 'page' : undefined}
                ref={activeId === c.id ? setActiveRowRef : undefined}
              >
                <span className="chat-list-avatar">
                  {c.avatar_url ? <SignedImage bucket="avatars" stored={c.avatar_url} alt="" /> : c.nickname.slice(0, 1)}
                </span>
                <span className="chat-list-info">
                  <span className="chat-list-name">
                    {c.nickname}
                    {c.unread > 0 && <span className="chat-unread-badge">{c.unread > 99 ? '99+' : c.unread}</span>}
                  </span>
                  {(c.lastMsg || c.lastImage || c.lastRecalled) && (
                    <span className="chat-list-preview">
                      {c.lastRecalled
                        ? '[已撤回]'
                        : (c.lastVideo ? '[视频]'
                          : (c.lastFile ? '[文件]' : (c.lastImage ? '[图片]' : truncate(c.lastMsg))))}
                    </span>
                  )}
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