import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { safeStorageKey } from '../lib/sanitizeFilename'
import { compressImage } from '../lib/compressImage'
import ImageLightbox from '../components/ImageLightbox'
import SignedImage from '../components/SignedImage'
import { objectLocator, resolveSignedUrl, storagePathFromUrl } from '../lib/signedUrls'
import { uploadEncryptedImage, useContentImageUrls } from '../lib/imageCrypto'
import { fetchThreadData, readCachedThread, writeCachedThread } from '../lib/chatCache'
// 阶段 1：私聊文本端到端加密（会话密钥由双方身份密钥 ECDH 得到，见 lib/crypto.js）
import {
  conversationKey, decryptPeerMessages, encryptForPeer, onUnlockChange, unlockStateVersion,
} from '../lib/crypto'

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

// 已经尝试过"补加密"的消息 id（避免每次渲染都重复请求；失败的下次还能再试）
const backfillTried = new Set()
// 后台扫尾是否已经在本页面跑过（一次进程只跑一条，避免来回切会话时并发扫同一批）
let sweepRunning = false

/**
 * 把本会话里**我发的历史明文**逐批换成密文（后台、串行、静默、可中断）。
 * 为什么需要它：会话一次只加载 50 条，靠"看到才补"根本补不完 1700+ 条历史。
 * 为什么放在这里而不是服务端：加密用的私钥只存在于使用者自己的设备上，服务端做不了这件事。
 * 预算：一次最多 300 条、每批 50 条、批间 150ms —— 对使用者完全无感，下次打开接着扫
 * （实测每条约 150ms 的往返，300 条约一分钟；1700 条历史几次打开就扫完了）。
 */
async function sweepPlaintextOnce(me, peerId) {
  if (sweepRunning || !me || !peerId) return
  sweepRunning = true
  let budget = 300
  let oldest = null
  let queryFails = 0
  let rowFails = 0
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  try {
    while (budget > 0 && queryFails < 3) {
      let q = supabase
        .from('messages')
        .select('id, content, created_at')
        .eq('sender_id', me)
        .eq('recipient_id', peerId)
        .is('ciphertext', null)
        .is('recalled_at', null)
        .not('content', 'is', null)
        .order('created_at', { ascending: false })
        .limit(50)
      if (oldest) q = q.lt('created_at', oldest)
      const { data, error } = await q
      if (error) {
        // 网络/后端的偶发抖动不该让整个扫尾停摆（实测：一次抖动就让剩下几十条再也不补了）
        queryFails += 1
        console.warn('[chat] 扫尾查询失败，1 秒后重试:', error.message)
        await sleep(1000)
        continue
      }
      queryFails = 0
      if (!data || data.length === 0) break
      oldest = data[data.length - 1].created_at
      const items = []
      const okIds = []
      for (const row of data) {
        if (rowFails >= 5) break
        try {
          const sealed = await encryptForPeer(peerId, row.content)
          if (!sealed) { console.warn('[chat] 扫尾：本机没解锁或对方还没有公钥，先停'); return }
          items.push({ id: row.id, ...sealed })
          okIds.push(row.id)
        } catch (err) {
          rowFails += 1
          console.warn('[chat] 扫尾单条失败:', err?.message)
          await sleep(400)
        }
      }
      if (items.length > 0) {
        const { data: n, error: rpcErr } = await supabase.rpc('encrypt_message_payloads', { p_items: items })
        if (rpcErr) {
          rowFails += 1
          console.warn('[chat] 扫尾批量写失败:', rpcErr.message)
          await sleep(600)
        } else {
          rowFails = 0
          budget -= Math.max(0, Number(n) || 0)
          void okIds
        }
      }
      await sleep(150)
    }
  } catch (err) {
    // 尽力而为：退登等极端情况走到这里，静默收工（下次打开接着扫）
    console.warn('[chat] 扫尾中断:', err?.message)
  } finally {
    console.info('[chat] 扫尾结束，本次补加密', 300 - budget, '条')
  }
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
  // ⚠️ 两层：`rawMessages` 是数据库里那一行（密文），`messages` 是解密后给界面用的。
  //    落盘缓存、实时补丁、撤回/编辑都只碰 raw，明文永远不出内存。
  const [rawMessages, setRawMessages] = useState([])
  const [messages, setMessages] = useState([])
  // 密钥进内存是"晚一点才发生"的事（登录解锁 / 设备缓存解锁）。订阅它的版本号，
  // 解锁后自动重算一次解密；否则先渲染的界面会永远停在"读不到"（实测踩到过）。
  const [unlockV, setUnlockV] = useState(() => unlockStateVersion())
  useEffect(() => onUnlockChange(setUnlockV), [])
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
  // 一次把当前所有消息图片签出来（点灯箱、开新标签页都用它）
  const chatImageUrls = useMemo(
    () => messages.map((m) => m.image_url).filter(Boolean),
    [messages],
  )
  // 私聊图片：签名 → 下载 → 用**会话密钥**在本机解密（见 lib/imageCrypto.js）
  const signedImages = useContentImageUrls(chatImageUrls, {
    resolveKey: () => conversationKey(userId),
  })
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
      // 先用内存里的缓存把这一屏画出来（同一次会话里返回再进、或列表悬停预取过）。
      // 画完照旧去取最新的 —— 缓存只是"先顶一下"，不改变任何判断。
      const cached = readCachedThread(me, userId)
      if (cached) {
        setOtherProfile((prev) => prev ?? cached.profile)
        setRawMessages((prev) => (prev.length > 0 ? prev : cached.messages))
        setHasMore((prev) => (messages.length > 0 ? prev : cached.messages.length >= PAGE_SIZE))
        setLoading(false)
      }
      // 只取最近一页，进来就能用；更早的历史按需加载。
      // 用 desc + limit 拿最新 N 条，再反转成时间正序展示。
      const data = await fetchThreadData(me, userId, PAGE_SIZE)
      if (cancelled) return
      if (!data) {
        // 拿不到数据：有缓存就留着内容，没缓存才报错
        if (!cached) setError('加载失败，请下拉刷新或稍后再试')
        setLoading(false)
        return
      }
      setOtherProfile(data.profile)
      setRawMessages(data.messages)
      setHasMore(data.pageLength === PAGE_SIZE)
      writeCachedThread(me, userId, { profile: data.profile, messages: data.messages })
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
          setRawMessages((prev) => [...prev, m])
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
        // ⚠️ 只合并进 `rawMessages`（数据库那一行），**绝不直接改 `messages`**：
        //    密文行的 content 就是 null，直接合并会把刚解出来的明文擦掉，
        //    而且解密 effect 不会再跑一次 —— 界面就永久停在"读不到"（实测踩到过：
        //    自己发出的消息在对方标记已读的那一瞬间变成 🔒）。
        //    改 raw 之后由解密 effect 重算，明文/撤回/编辑三种情况都对。
        setRawMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...m } : x)))
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
      .select('id, content, ciphertext, iv, scheme, image_url, recalled_at, sender_id')
      .in('id', missingQuoteIds)
      .then(async ({ data }) => {
        if (cancelled || !data || data.length === 0) return
        // 引用块也要显示明文：这里同样过一遍解密（密钥有缓存，不会多请求）
        const rows = await decryptPeerMessages(userId, data)
        if (cancelled) return
        setQuotedCache((prev) => {
          // 只有真的有新增才换引用，否则这个 effect 会自己触发自己，变成死循环
          let changed = false
          const next = { ...prev }
          for (const row of rows) {
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
      setRawMessages((prev) => [...older, ...prev])
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
        // 图片端到端加密（阶段 3）：用**会话密钥**在设备上加密后再上传。
        // 拿不到钥匙（本机没解锁 / 对方没公钥）就退回明文上传 —— 宁可暂时不加密，
        // 也不能让使用者发不出图片（读路径两种都认，见 lib/imageCrypto.js）。
        const ck = await conversationKey(userId)
        const up = await uploadEncryptedImage(path, prepared, ck)
        if (!up.ok) {
          console.warn('[image] 这张图片没能加密，按明文上传:', up.reason)
          const { error: uploadError } = await supabase.storage
            .from('moment-images')
            .upload(path, prepared, { contentType: prepared.type })
          if (uploadError) throw uploadError
        }
        // 桶已私有：存的是**定位串**（本身不可访问），渲染时统一换签名地址
        imageUrl = objectLocator('moment-images', path)
      }
      // 文本加密后再入库（库里只留密文）。拿不到密钥时（本机没解锁 / 对方还没公钥）
      // 退回明文发送：宁可这一刻漏加密，也不能让使用者发不出消息；控制台留一行便于排查。
      const text = content.trim()
      let body = { content: text || null }
      if (text) {
        const sealed = await encryptForPeer(userId, text)
        if (sealed) body = { ...sealed, content: null }
        else console.warn('[chat] 这条消息没能加密（本机未解锁或对方缺少公钥）')
      }
      const { error } = await supabase
        .from('messages')
        .insert({
          sender_id: me,
          recipient_id: userId,
          image_url: imageUrl,
          reply_to_id: replyTarget?.id ?? null,
          ...body,
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
        .update({ recalled_at: stamp, content: null, image_url: null, ciphertext: null, iv: null })
        .eq('id', message.id)
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) throw new Error('撤回没有生效（可能已超过 2 分钟窗口）')
      setRawMessages((prev) =>
        prev.map((x) =>
          x.id === message.id
            ? { ...x, recalled_at: stamp, content: null, image_url: null, ciphertext: null, iv: null }
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
      const sealed = await encryptForPeer(userId, next)
      const patch = sealed ? { ...sealed, content: null } : { content: next }
      const { data, error } = await supabase
        .from('messages')
        .update(patch)
        .eq('id', editing.id)
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) throw new Error('编辑没有生效（可能已超过 2 分钟窗口）')
      const stamp = new Date().toISOString()
      setRawMessages((prev) =>
        prev.map((x) => (x.id === editing.id ? { ...x, ...patch, edited_at: stamp } : x))
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

  // 原始行（可能是密文）→ 渲染用的 `messages`（明文）。
  // 密钥还没进内存时拿不到钥匙，密文行会显示成"读不到"；解锁后 unlockV 变化会自动重跑。
  useEffect(() => {
    let cancelled = false
    // 第一帧先按"库里的行"画出来：明文行立刻可见、密文行沿用本地缓存里的明文。
    // 不这么做的话，缓存本来"立刻出画面"的效果会被一行 `await`（取对方公钥 + ECDH）吃掉 ——
    // 实测：返回再进会话从 ~800ms 退化到 818ms（`verify-chat-cache` 直接红）。
    setMessages(rawMessages)
    ;(async () => {
      const out = await decryptPeerMessages(userId, rawMessages)
      if (!cancelled) setMessages(out)
      // 顺手把**自己**的历史明文消息补加密（每次最多 25 条、逐条串行、失败静默）。
      // 为什么值得做：不然库里会一直躺着历史明文，"服务器看不到内容"就只对新消息成立。
      // 只能改自己发的（RPC 里也这么卡），所以两边都打开过对话才算补完。
      if (cancelled) return
      const todo = out
        .filter((row) => row.sender_id === me && row.content && !row.ciphertext && !backfillTried.has(row.id))
        .slice(0, 25)
      if (todo.length > 0) {
        try {
          // 一批一次请求（踩过的坑：一条一次 RPC 实测 0.34 秒/条，1900 条要几分钟）
          const items = []
          const local = []
          for (const row of todo) {
            backfillTried.add(row.id)
            const sealed = await encryptForPeer(userId, row.content)
            if (!sealed) { backfillTried.delete(row.id); break }
            items.push({ id: row.id, ...sealed })
            local.push({ id: row.id, ...sealed })
          }
          if (items.length > 0) {
            const { data, error } = await supabase.rpc('encrypt_message_payloads', { p_items: items })
            if (error || !(data > 0)) {
              for (const it of local) backfillTried.delete(it.id)
            } else if (!cancelled) {
              const byId = new Map(local.map((it) => [it.id, it]))
              setRawMessages((prev) => prev.map((x) => (
                byId.has(x.id) ? { ...x, content: null, ...byId.get(x.id) } : x
              )))
            }
          }
        } catch {
          for (const row of todo) backfillTried.delete(row.id)
        }
      }
      // 一屏只有 50 条，光靠"看到哪条补哪条"要翻很久才补完历史。所以再开一条**后台扫尾**：
      // 从最新的明文开始往前翻，每次进程最多 200 条、每批之间歇 250ms，翻完或本条会话结束就停。
      // 它不碰界面状态（那些行根本没渲染），只是把库里的历史明文换成密文；下次进来接着扫（幂等）。
      if (!cancelled && todo.length === 0) sweepPlaintextOnce(me, userId)
    })()
    return () => { cancelled = true }
  }, [userId, rawMessages, me, unlockV])

  // 消息有任何变化（自己发的、对方发的、撤回/编辑）都同步进内存缓存，
  // 这样"返回列表再进来"看到的就是最新状态，而不是缓存那一刻的旧快照。
  useEffect(() => {
    if (loading || !otherProfile) return
    // 缓存里**带上已解出来的明文**：下次进来第一帧就显示内容，而不是先闪一下"读不到"。
    // 这不是新增信任面 —— 会话列表预览本来就已经明文落在同一个 localStorage 里
    // （防的是云，不防"拿到你解锁设备的人"，与设备缓存同一取舍，已写进 SECURITY.md）。
    const decrypted = new Map(messages.map((m) => [m.id, m.content]))
    const rows = rawMessages.map((r) => {
      const text = decrypted.get(r.id)
      return r.ciphertext && text ? { ...r, content: text } : r
    })
    writeCachedThread(me, userId, { profile: otherProfile, messages: rows })
  }, [loading, otherProfile, rawMessages, me, userId])

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
          onClick={async () => setLightboxSrc(await resolveSignedUrl('avatars', otherProfile?.avatar_url))}
          aria-label={otherProfile?.avatar_url ? '查看头像大图' : '没有头像'}
        >
          {otherProfile?.avatar_url ? (
            <SignedImage bucket="avatars" stored={otherProfile.avatar_url} alt="" />
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

                    {m.image_url && (() => {
                      const imageUrl = signedImages.get(m.image_url) ?? null
                      return (
                        <a
                          href={imageUrl ?? undefined}
                          className="chat-bubble-image"
                          title="点开查看大图"
                          data-signed={imageUrl ? '1' : '0'}
                          onClick={(e) => {
                            // Cmd / Ctrl / Shift + 点击照旧开新标签页，右键菜单也没被吃掉；
                            // 只接管普通左键，改成在当前页面里放大看
                            if (e.metaKey || e.ctrlKey || e.shiftKey) return
                            e.preventDefault()
                            if (imageUrl) setLightboxSrc(imageUrl)
                          }}
                        >
                          <img src={imageUrl ?? undefined} alt="" />
                        </a>
                      )
                    })()}

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
                        {/* 密文行但本机解不开（极少数：还没解锁 / 换了账号）→ 别显示空气泡 */}
                        {!m.content && m.ciphertext && (
                          <span className="chat-encrypted-hint">🔒 这条消息在这台设备上读不到</span>
                        )}
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