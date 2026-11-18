import { useEffect, useLayoutEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import SignedImage from '../components/SignedImage'
import { prefetchThread, readChatListSnapshot, writeChatListSnapshot } from '../lib/chatCache'
import { decryptForPeer } from '../lib/crypto'
import { loadGroupSummaries } from '../lib/groupChat'
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

export default function ChatList() {
  const session = useAuth()
  const [conversations, setConversations] = useState([])
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')

  // 先用上次的快照把联系人画出来（见 lib/chatCache.js）。
  // ⚠️ useLayoutEffect：要在**第一帧之前**就把内容放进去，否则先闪一下"加载中"。
  useLayoutEffect(() => {
    const uid = session?.user?.id
    if (!uid) return
    const cached = readChatListSnapshot(uid)
    if (!cached) return
    setConversations((prev) => (prev.length > 0 ? prev : cached))
    setLoading(false)
  }, [session?.user?.id])

  useEffect(() => {
    async function load() {
      const me = session.user.id
      // 群聊摘要和联系人并行拉；群加载失败不影响 1:1 列表
      const groupPromise = loadGroupSummaries(me).catch(() => ({ summaries: [] }))
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

        // 最后一条是密文时，解出预览（解不开就不显示预览，绝不显示乱码）
        const decryptedLast = {}
        await Promise.all(Object.entries(latestByPartner).map(async ([partnerId, last]) => {
          if (!last.ciphertext || !last.iv) return
          try {
            const text = await decryptForPeer(partnerId, last)
            // 表情/文件消息在列表里只显示「[表情]」「[文件]」（不把 [[s:xxx]]、
            // {"v":1,"kind":"file",…} 这种内部标记露给使用者）
            const isVideo = typeof text === 'string' && text.startsWith('{"v":1,"kind":"video"')
            const fileEnvelope = typeof text === 'string' && text.startsWith('{"v":1,"kind":"file"')
            decryptedLast[partnerId] = stickerIdFromContent(text)
              ? '[表情]'
              : (isVideo ? '[视频]' : (fileEnvelope ? '[文件]' : text))
          } catch {
            decryptedLast[partnerId] = null
          }
        }))

        // AI 成员（Ace）不进 1:1 列表：它住在「私密圈后花园」那个群里，
        // 这里再出现一个"Ace 私聊"只会让人以为有两个入口。
        const humans = (profileRes.data ?? []).filter((p) => !p.is_ai)
        const merged = humans.map((p) => ({
          ...p,
          lastMsg: (p.id in decryptedLast)
            ? (decryptedLast[p.id] ?? '🔒 消息')
            : (latestByPartner[p.id]?.content ?? null),
          lastImage: latestByPartner[p.id]?.image_url ?? null,
          // 附件是文件还是图片？看**解密后的正文**（文件名/类型都藏在密文里，
          // 所以服务端只知道"有个附件"，由本机解密后才决定显示 [文件] 还是 [图片]）
          // ⚠️ 上面已经把文件信封**转成** '[文件]' 了，这里要按转换后的值判断
          //    （第一版按原始 JSON 前缀判断，永远为 false —— 实测踩到）
          lastFile: decryptedLast[p.id] === '[文件]',
          lastVideo: decryptedLast[p.id] === '[视频]',
          lastRecalled: !!latestByPartner[p.id]?.recalled_at,
          lastTime: latestByPartner[p.id]?.created_at ?? null,
          unread: unreadCounts[p.id] || 0,
        }))

        merged.sort((a, b) => {
          const tA = a.lastTime ? new Date(a.lastTime).getTime() : 0
          const tB = b.lastTime ? new Date(b.lastTime).getTime() : 0
          return tB - tA
        })

        setConversations(merged)
        writeChatListSnapshot(me, merged)
      }
      // 群摘要最后填充：它自己解密，失败了也只是少一行，不影响上面的联系人
      const gs = await groupPromise
      if (gs?.summaries) setGroups(gs.summaries)
      setLoading(false)
    }
    load()
  }, [session.user.id])

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
      {shownGroups.length > 0 && (
        <ul className="chat-list chat-group-list">
          {shownGroups.map(({ thread: g, latest, unread, lastTime }) => (
            <li key={g.id}>
              <Link to="/garden" className="chat-list-item chat-group-item" data-group-id={g.id}>
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
        <p className="status-text">还没有聊天记录。</p>
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
              <Link to={`/chat/${c.id}`} className="chat-list-item">
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