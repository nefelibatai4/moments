// Moments 扩展的 background service worker
//
// 职责只有四件：
//   1. 持有会话（从网页同步来的，见 content.js），必要时刷新 access token；
//   2. 定期查未读私信数，写到工具栏角标上；
//   3. 管理面板：点图标 → 往当前网页注入毛玻璃浮层（overlay.js）；
//      注入不了（chrome:// 内置页、扩展商店、PDF 阅读器…）或浮层报"网页不让嵌"时，
//      退回「独立小窗」（panel.html，即 0.1.0 的那个弹窗形态）；
//   4. 在网页与浮层之间转交面板背景设置。
//
// ⚠️ MV3 最重要的限制：service worker 空闲约 30 秒就会被回收，
// 所以这里**不能用长连接**（Supabase Realtime 的 websocket 撑不住）。
// 保底且可靠的做法是 chrome.alarms 定时轮询——alarms 能把被回收的 worker 唤醒。
// 系统通知那一层不需要这里操心：网页版的 Web Push 已经在做，而且是全局的。

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'

const ALARM_NAME = 'moments-poll'
const POLL_MINUTES = 1
// 兜底小窗。0.1.0 里它是 action 弹窗，现在只在浮层不可用时才出现。
const PANEL_PAGE = 'panel.html'
const PANEL_WINDOW_KEY = 'panelWindowId'
const PANEL_DEFAULT_SETTINGS = { mode: 'glass', blur: 12 }
// 面板高度：默认由 CSS 决定（上方 1/4 屏），用户拖过之后记在这里（单位 px）
const PANEL_HEIGHT_KEY = 'panelHeightPx'
const BADGE_COLOR = '#ff6363' // 与 app 的 --accent-red 一致
const BADGE_MAX = 99
// 群聊"读到哪"由网页的 content script 同步过来（见 content.js / groupChat.js）。
// 扩展读不到网页的 localStorage，所以这里存一份 { [uid]: { [threadId]: iso } }。
const GROUP_SEEN_KEY = 'groupSeen'

// 未读展示方式（2026-11-12 使用者要求：可以从"数字"切成"图标变色"，并保留数字可选）
//   number = 数字角标（默认）
//   dot    = 只显示一个小圆点（不显示数字）
//   tint   = 不改角标，改**图标本身**的颜色（有未读时图标变红）
const UNREAD_STYLE_KEY = 'unreadStyle'
const DEFAULT_UNREAD_STYLE = 'number'
let unreadStyle = DEFAULT_UNREAD_STYLE
let lastUnreadCount = 0
// 角标只显示总数，但 tooltip 要能说清"其中私信几条、群聊几条"
let lastBreakdown = { dm: 0, group: 0 }
let lastPainted = null
const TINT_COLOR = '#ff5a5f'

const log = (...args) => console.log('[moments-ext]', ...args)

// ---------------------------------------------------------------- 会话存取

async function getSession() {
  const { session } = await chrome.storage.local.get('session')
  return session || null
}

async function setSession(session) {
  await chrome.storage.local.set({ session })
}

async function clearSession() {
  await chrome.storage.local.remove(['session', 'status'])
}

// access token 默认 1 小时过期。提前 5 分钟刷新，避免刚好卡在过期点上。
const REFRESH_MARGIN_SEC = 5 * 60

async function ensureFreshToken(session) {
  const nowSec = Math.floor(Date.now() / 1000)
  if (session.expires_at && session.expires_at - nowSec > REFRESH_MARGIN_SEC) {
    return session.access_token
  }

  log('access token 即将过期，刷新中')
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  })

  if (!res.ok) {
    // refresh token 失效（可能被网页那边轮换掉了）。清掉会话，等网页重新同步。
    log('刷新失败，清除本地会话', res.status)
    await clearSession()
    return null
  }

  const data = await res.json()
  const next = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || session.refresh_token,
    expires_at: data.expires_at || nowSec + (data.expires_in || 3600),
    user_id: data.user?.id || session.user_id,
  }
  await setSession(next)
  return next.access_token
}

// ---------------------------------------------------------------- 未读数

// 用 REST 直接查，不引 supabase-js：
// 依赖越少越好，而且 service worker 里没有 localStorage，用 supabase-js
// 还得给它写一个 chrome.storage 适配器，不值得。
//
// 角标口径 = **未读私信 + 未读群聊**。
//  - 私信：messages.read_at 为空（服务端已有已读回执）；
//  - 群聊：群消息没有服务端已读表（群里就两个人 + AI，不做回执），
//    已读位置记在网页 localStorage。content.js 把那份位置同步到 chrome.storage，
//    这里再按"比已读时间新、不是自己发的"数行数。
//    ⚠️ 群消息是密文，扩展解不开、也分不出 AI 状态行；这对角标是可接受的：
//        AI 的"思考中"和它后面的回答是**同一行**（bridge 就地 UPDATE），不会重复计数。
// 动态/评论/点赞那几张表没有「已读」概念，统计不准，所以不纳入口径。

const REST_HEADERS = (accessToken) => ({
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${accessToken}`,
})

async function fetchDmUnreadCount(userId, accessToken) {
  const url =
    `${SUPABASE_URL}/rest/v1/messages` +
    `?select=id&recipient_id=eq.${encodeURIComponent(userId)}&read_at=is.null&limit=${BADGE_MAX + 1}`

  const res = await fetch(url, { headers: REST_HEADERS(accessToken) })

  if (res.status === 401) return { error: 'unauthorized' }
  if (!res.ok) return { error: `http ${res.status}` }

  const rows = await res.json()
  return { count: Array.isArray(rows) ? rows.length : 0 }
}

/** 取这个账号在网页里记下的"每个群读到哪"（没有记录就返回空对象） */
async function getGroupSeen(userId) {
  if (!userId) return {}
  const { [GROUP_SEEN_KEY]: all } = await chrome.storage.local.get(GROUP_SEEN_KEY)
  const seen = all && all[userId]
  return seen && typeof seen === 'object' && !Array.isArray(seen) ? seen : {}
}

/**
 * 把网页上报的已读位置合并进来。
 *
 * 为什么是"取更晚的那个"而不是覆盖：同一浏览器可能开着多个标签页/面板，
 * 各自 localStorage 分区的进度不一样；一个旧标签页晚上报一次不能把角标又点亮。
 */
async function mergeGroupSeen(userId, incoming) {
  if (!userId || !incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return false

  const { [GROUP_SEEN_KEY]: all } = await chrome.storage.local.get(GROUP_SEEN_KEY)
  const store = all && typeof all === 'object' && !Array.isArray(all) ? all : {}
  const current = store[userId] && typeof store[userId] === 'object' ? store[userId] : {}
  const merged = { ...current }
  let changed = false

  for (const [threadId, iso] of Object.entries(incoming)) {
    const next = new Date(iso).getTime()
    if (!threadId || !Number.isFinite(next)) continue
    const prev = new Date(merged[threadId] || 0).getTime()
    if (next > (Number.isFinite(prev) ? prev : 0)) {
      merged[threadId] = iso
      changed = true
    }
  }

  if (!changed) return false
  store[userId] = merged
  await chrome.storage.local.set({ [GROUP_SEEN_KEY]: store })
  return true
}

/** 群聊未读：RLS 只返回我是成员的群，所以不需要在客户端再筛成员 */
async function fetchGroupUnreadCount(userId, accessToken) {
  const headers = REST_HEADERS(accessToken)

  const threadsRes = await fetch(`${SUPABASE_URL}/rest/v1/group_threads?select=id,created_at`, { headers })
  if (threadsRes.status === 401) return { error: 'unauthorized' }
  if (!threadsRes.ok) return { error: `group http ${threadsRes.status}` }

  const threads = await threadsRes.json()
  if (!Array.isArray(threads) || threads.length === 0) return { count: 0 }

  const seen = await getGroupSeen(userId)
  let count = 0

  for (const thread of threads) {
    // 没打开过这个群 → 从建群时间算起。网页里的群角标在"从没打开过"时是 0，
    // 但扩展的目标是"有新东西就提醒"，宁可多提醒一次，也别漏掉第一条。
    const seenAt = seen[thread.id]
    const since = Number.isFinite(new Date(seenAt).getTime()) ? seenAt : thread.created_at
    const params = new URLSearchParams({
      select: 'id',
      thread_id: `eq.${thread.id}`,
      sender_id: `neq.${userId}`,
      created_at: `gt.${since}`,
      limit: String(BADGE_MAX + 1),
    })
    const res = await fetch(`${SUPABASE_URL}/rest/v1/group_messages?${params}`, { headers })
    if (res.status === 401) return { error: 'unauthorized' }
    if (!res.ok) return { error: `group http ${res.status}` }

    const rows = await res.json()
    count += Array.isArray(rows) ? rows.length : 0
    if (count > BADGE_MAX) break // 角标最多显示 99+，不用继续数
  }

  return { count }
}

/** 私信 + 群聊。群聊查询失败不让私信角标一起消失（旧库没有群表时也要能用）。 */
async function fetchUnreadCounts(userId, accessToken) {
  const [dm, group] = await Promise.all([
    fetchDmUnreadCount(userId, accessToken),
    fetchGroupUnreadCount(userId, accessToken),
  ])

  if (dm.error) return { error: dm.error }
  if (group.error === 'unauthorized') return { error: 'unauthorized' }

  const dmUnread = dm.count || 0
  const groupUnread = group.error ? 0 : (group.count || 0)
  return {
    count: dmUnread + groupUnread,
    dmUnread,
    groupUnread,
    groupError: group.error || null,
  }
}

// ---------------------------------------------------------------- 角标

/** 把图标染成某种颜色（用于 tint 模式）—— 用 OffscreenCanvas 在 SW 里现画，不需要多套素材 */
async function tintedIconData(color) {
  const cacheKey = `tint:${color}`
  if (iconRenderCache.has(cacheKey)) return iconRenderCache.get(cacheKey)
  const sizes = [16, 32, 48, 128]
  const out = {}
  for (const size of sizes) {
    try {
      const res = await fetch(chrome.runtime.getURL(`icons/icon${size}.png`))
      const bitmap = await createImageBitmap(await res.blob())
      const canvas = new OffscreenCanvas(size, size)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0, size, size)
      // source-atop：只给"已经有像素"的地方上色，透明区域保持透明
      ctx.globalCompositeOperation = 'source-atop'
      ctx.fillStyle = color
      ctx.fillRect(0, 0, size, size)
      out[size] = ctx.getImageData(0, 0, size, size)
    } catch {
      /* 某个尺寸失败就跳过，其它尺寸照用 */
    }
  }
  const data = Object.keys(out).length ? out : null
  // 缓存起来：图标只取决于（模式/颜色），没必要每次刷新都重画一遍
  iconRenderCache.set(cacheKey, data)
  return data
}

const BASE_ICON = { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' }

/**
 * 在图标右上角画一个**小圆点**（用于"小红点"样式）。
 *
 * 为什么不用角标做红点：`setBadgeText(' ')` 画出来的是**浏览器统一大小的方块**，
 * 使用者 2026-11-12 说"红点太大了，应该只有 Logo 的四分之一"。角标的大小改不了，
 * 所以改成把点**画进图标里** —— 尺寸/位置完全可控（默认直径 = 图标边长 / 4）。
 */
const iconRenderCache = new Map()

async function dottedIconData({ ratio = 1 / 4, color = BADGE_COLOR } = {}) {
  const cacheKey = `dot:${ratio}:${color}`
  if (iconRenderCache.has(cacheKey)) return iconRenderCache.get(cacheKey)
  const sizes = [16, 32, 48, 128]
  const out = {}
  for (const size of sizes) {
    try {
      const res = await fetch(chrome.runtime.getURL(`icons/icon${size}.png`))
      const bitmap = await createImageBitmap(await res.blob())
      const canvas = new OffscreenCanvas(size, size)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0, size, size)
      const d = Math.max(3, Math.round(size * ratio))
      const m = Math.max(1, Math.round(size * 0.04))     // 右上角留一点边
      const x = size - d - m
      const y = m
      ctx.beginPath()
      ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      // 一圈极细的描边，深色图标上也能看清（尺寸小时不加，免得糊成一团）
      if (size >= 32) {
        ctx.lineWidth = Math.max(1, size / 64)
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx.stroke()
      }
      out[size] = ctx.getImageData(0, 0, size, size)
    } catch {
      /* 某尺寸失败就跳过 */
    }
  }
  const data = Object.keys(out).length ? out : null
  iconRenderCache.set(cacheKey, data)
  return data
}

/** 按当前模式画未读指示（数字 / 圆点 / 图标变色） */
async function paintBadge(count, breakdown) {
  lastUnreadCount = count || 0
  if (breakdown) lastBreakdown = breakdown

  const style = unreadStyle
  const n = lastUnreadCount

  try {
    if (style === 'tint') {
      // 图标变色：角标清空；有未读 → 染色图标，无未读 → 原图标
      await chrome.action.setBadgeText({ text: '' })
      const data = n > 0 ? await tintedIconData(TINT_COLOR) : null
      await chrome.action.setIcon(data ? { imageData: data } : { path: BASE_ICON })
    } else if (style === 'dot') {
      // 小红点：**画进图标里**（角标大小浏览器不让改，那样点会太大）
      await chrome.action.setBadgeText({ text: '' })
      const data = n > 0 ? await dottedIconData() : null
      await chrome.action.setIcon(data ? { imageData: data } : { path: BASE_ICON })
    } else {
      const text = !n ? '' : n > BADGE_MAX ? `${BADGE_MAX}+` : String(n)
      await chrome.action.setBadgeText({ text })
      if (text) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR })
      await chrome.action.setIcon({ path: BASE_ICON })
    }
    lastPainted = `${style}:${n}`
  } catch (e) {
    log('画角标失败', e && e.message)
  }

  const text = !n ? '' : n > BADGE_MAX ? `${BADGE_MAX}+` : String(n)
  const parts = []
  if (lastBreakdown.dm > 0) parts.push(`私信 ${lastBreakdown.dm}`)
  if (lastBreakdown.group > 0) parts.push(`群聊 ${lastBreakdown.group}`)
  const detail = parts.length > 1 ? `（${parts.join(' · ')}）` : ''
  await chrome.action.setTitle({
    title: n ? `Moments 私密圈 · ${n} 条未读${detail}` : 'Moments 私密圈',
  })
  return text
}

async function setStatus(patch) {
  const { status } = await chrome.storage.local.get('status')
  await chrome.storage.local.set({ status: { ...(status || {}), ...patch } })
}

// ---------------------------------------------------------------- 主流程

async function refresh() {
  const session = await getSession()
  if (!session || !session.user_id) {
    await paintBadge(0, { dm: 0, group: 0 })
    await setStatus({
      hasSession: false, unread: 0, dmUnread: 0, groupUnread: 0, groupError: null,
      lastChecked: Date.now(), lastError: null,
    })
    return
  }

  try {
    const token = await ensureFreshToken(session)
    if (!token) {
      await paintBadge(0, { dm: 0, group: 0 })
      await setStatus({
        hasSession: false, unread: 0, dmUnread: 0, groupUnread: 0, groupError: null,
        lastChecked: Date.now(), lastError: '会话已失效',
      })
      return
    }

    const { count, dmUnread, groupUnread, groupError, error } = await fetchUnreadCounts(session.user_id, token)
    if (error) {
      // 401 说明会话在别处失效了，清掉等重新同步；其他错误保留会话重试
      if (error === 'unauthorized') await clearSession()
      await setStatus({
        hasSession: error !== 'unauthorized', unread: 0, dmUnread: 0, groupUnread: 0, groupError: null,
        lastChecked: Date.now(), lastError: error,
      })
      if (error === 'unauthorized') await paintBadge(0, { dm: 0, group: 0 })
      return
    }

    const breakdown = { dm: dmUnread || 0, group: groupUnread || 0 }
    if (groupError) log('群聊未读查询失败（角标先只算私信）', groupError)
    await paintBadge(count || 0, breakdown)
    await setStatus({
      hasSession: true, unread: count || 0, dmUnread: breakdown.dm, groupUnread: breakdown.group,
      groupError: groupError || null, lastChecked: Date.now(), lastError: null,
    })
  } catch (e) {
    // 网络不可用等情况：保留上次的角标，不要把数字抹掉
    log('刷新失败', e && e.message)
    await setStatus({ lastError: (e && e.message) || '网络错误', lastChecked: Date.now() })
  }
}

// 网页那边同步来会话
async function handleSessionPush(incoming) {
  if (!incoming || !incoming.access_token || !incoming.user?.id) return
  const current = await getSession()

  // 只在 access_token 变化时才写，避免每 10 秒重复触发刷新
  if (current && current.access_token === incoming.access_token) return

  // ⚠️ 这里的关键取舍：网页同步来的会话**优先于**扩展自己刷新的结果。
  // 因为 supabase 会轮换 refresh token，两边各自刷新会互相作废。
  // 网页是会话的源头（用户在那里登录），所以以它为准。
  await setSession({
    access_token: incoming.access_token,
    refresh_token: incoming.refresh_token,
    expires_at: incoming.expires_at,
    user_id: incoming.user.id,
  })
  log('已从网页同步会话')
  await refresh()
}

// 启动/安装时读一次"未读展示方式"
chrome.storage.local.get(UNREAD_STYLE_KEY).then((r) => {
  if (r && (r[UNREAD_STYLE_KEY] === 'dot' || r[UNREAD_STYLE_KEY] === 'tint' || r[UNREAD_STYLE_KEY] === 'number')) {
    unreadStyle = r[UNREAD_STYLE_KEY]
  }
  paintBadge(lastUnreadCount)
}).catch(() => {})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[UNREAD_STYLE_KEY]) return
  const next = changes[UNREAD_STYLE_KEY].newValue
  if (next === 'dot' || next === 'tint' || next === 'number') {
    unreadStyle = next
    paintBadge(lastUnreadCount)
  }
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'session:push') {
    handleSessionPush(msg.session).finally(() => sendResponse({ ok: true }))
    return true // 异步响应
  }
  if (msg && msg.type === 'session:clear') {
    clearSession().then(() => refresh()).finally(() => sendResponse({ ok: true }))
    return true
  }
  if (msg && msg.type === 'refresh') {
    refresh().then(() => sendResponse({ ok: true }))
    return true
  }
  if (msg && msg.type === 'keycache:push') {
    // 某个网页上下文解锁过 → 把这套"设备缓存"记在扩展里，供别的存储分区（别的网站的面板）取用
    chrome.storage.local.set({ keyCache: msg.keyCache }).finally(() => sendResponse({ ok: true }))
    return true
  }
  if (msg && msg.type === 'keycache:get') {
    chrome.storage.local.get('keyCache').then(({ keyCache }) => sendResponse({ keyCache: keyCache || null }))
    return true
  }
  if (msg && msg.type === 'unreadStyle:set') {
    const v = msg.value
    if (v === 'dot' || v === 'tint' || v === 'number') {
      chrome.storage.local.set({ [UNREAD_STYLE_KEY]: v }).finally(() => sendResponse({ ok: true }))
      return true
    }
    sendResponse({ ok: false })
    return false
  }
  if (msg && msg.type === 'group:seen:push') {
    // 网页里读了群（见 src/lib/groupChat.js 的 markGroupSeen）→ 合并已读位置后重算。
    // 不能直接清 0：私信可能还有未读，群也不一定只有一个。
    mergeGroupSeen(msg.uid, msg.seen).then(async (changed) => {
      if (!changed) return
      const session = await getSession()
      // 角标本来就是 0 时不必再查一遍：群里连续来消息、使用者正停在群页，
      // markGroupSeen 会一条一条上报，每次都重算就是白白多打几轮 API。
      // 用 storage 里的 status 而不是内存变量：service worker 随时可能被回收。
      const { status } = await chrome.storage.local.get('status')
      const visible = (status && status.unread > 0) || lastUnreadCount > 0
      if (session && session.user_id === msg.uid && visible) await refresh()
    }).finally(() => sendResponse({ ok: true }))
    return true
  }
  if (msg && msg.type === 'unread:cleared') {
    // 网页里私信未读归零 → 立刻重算，而不是直接清角标：
    // 群聊可能还有未读，无脑 paintBadge(0) 会把群聊的红点一起抹掉。
    refresh().finally(() => sendResponse({ ok: true }))
    return true
  }
  if (msg && msg.type === 'panel:settings') {
    // content.js 转交来的网页设置：存下来，浮层通过 storage.onChanged 自动跟上
    setPanelSettings(msg.settings, msg.theme).finally(() => sendResponse({ ok: true }))
    return true
  }
  if (msg && msg.type === 'panel:getSettings') {
    getPanelSettings().then((res) => sendResponse(res))
    return true
  }
  if (msg && msg.type === 'state:get') {
    // 面板里的网页会来要"全局状态"：会话 + 主题 + 面板背景。
    // 为什么由扩展给：面板是嵌在**别人网页**里的 iframe，那一层的 localStorage
    // 可能读不到、甚至一访问就抛（第三方存储策略），那样面板就会显示成"没登录"。
    // 扩展手里本来就有一份（网页自己同步过来的），直接给它。
    Promise.all([getSession(), getPanelSettings()]).then(([session, panel]) => {
      sendResponse({
        session: session
          ? { access_token: session.access_token, refresh_token: session.refresh_token }
          : null,
        theme: panel.theme,
        panelBg: panel.settings,
      })
    })
    return true
  }
  if (msg && msg.type === 'panel:setHeight') {
    // 高度是"用户自己拖出来的"偏好，跟着使用者走（不是按站点存）。
    // 传 null 表示"恢复默认"→ 把记录删掉，让 CSS 的 25vh 重新生效。
    const patch = Number.isFinite(msg.height) ? { [PANEL_HEIGHT_KEY]: Math.round(msg.height) } : null
    const done = patch ? chrome.storage.local.set(patch) : chrome.storage.local.remove(PANEL_HEIGHT_KEY)
    done.finally(() => sendResponse({ ok: true }))
    return true
  }
  if (msg && msg.type === 'panel:fallback') {
    openFallbackWindow(msg.reason || '浮层报错').finally(() => sendResponse({ ok: true }))
    return true
  }
  if (msg && msg.type === 'panel:frameReady') {
    // 浮层里的网页（content.js 在 iframe 内，all_frames）报"我加载好了"。
    // 浮层自己收不到 iframe 的跨源消息，所以由这里转一手 ——
    // 这条消息也是浮层判断"网页有没有被 CSP 挡住"的唯一依据。
    if (sender && sender.tab && sender.tab.id != null) {
      chrome.tabs.sendMessage(sender.tab.id, { type: 'panel:frameReady' }).catch(() => {})
    }
    sendResponse({ ok: true })
    return true
  }
  if (msg && msg.type === 'status:get') {
    chrome.storage.local.get('status').then(({ status }) => sendResponse(status || null))
    return true
  }
  return false
})

// ---------------------------------------------------------------- 面板背景设置

// 设置的**源头在网页那边**（【我】里改，存在 localStorage，见
// src/lib/panelBackground.js），由 content.js 转交过来存在这里，
// 浮层再从这里取。扩展自己不做设置界面 —— 使用者明确要求开关放【我】里。
async function getPanelSettings() {
  const { panelBg, panelTheme, [PANEL_HEIGHT_KEY]: height } = await chrome.storage.local.get([
    'panelBg', 'panelTheme', PANEL_HEIGHT_KEY,
  ])
  return {
    settings: { ...PANEL_DEFAULT_SETTINGS, ...(panelBg || {}) },
    theme: panelTheme || 'dark',
    height: Number.isFinite(height) ? height : null,
  }
}

async function setPanelSettings(settings, theme) {
  const patch = {}
  if (settings) patch.panelBg = { ...PANEL_DEFAULT_SETTINGS, ...settings }
  if (theme) patch.panelTheme = theme
  if (Object.keys(patch).length === 0) return
  await chrome.storage.local.set(patch)
}

// ---------------------------------------------------------------- 面板开关

// 哪些页面注不进去（点了图标只能退回独立小窗）。
// 这份清单是实测出来的：`chrome.scripting.executeScript` 对这些 URL 会直接报错。
function isInjectable(url) {
  if (!url) return false
  if (!/^https?:\/\//i.test(url)) return false // chrome:// / edge:// / about: / file:// / devtools:// …
  if (/^https:\/\/chromewebstore\.google\.com\//i.test(url)) return false
  if (/^https:\/\/chrome\.google\.com\/webstore\//i.test(url)) return false
  return true
}

async function openFallbackWindow(reason) {
  log('打开兜底小窗：' + reason)
  // 已经开着就聚焦，不要开出一堆窗口
  const { [PANEL_WINDOW_KEY]: existingId } = await chrome.storage.local.get(PANEL_WINDOW_KEY)
  if (existingId != null) {
    try {
      const win = await chrome.windows.get(existingId)
      if (win) {
        await chrome.windows.update(existingId, { focused: true })
        return
      }
    } catch { /* 窗口已经关了，继续往下新建 */ }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(PANEL_PAGE),
    type: 'popup',
    width: 432,
    // 0.1.0 的 action 弹窗被 Chrome 硬顶在 600px；独立窗口没有这个限制，
    // 顺手把"面板太矮"一起解决了（STATUS 待办 #7）。
    height: 760,
  })
  if (win && win.id != null) await chrome.storage.local.set({ [PANEL_WINDOW_KEY]: win.id })
}

// 返回值刻意做成结构化的：`{ ok, via, reason }`。
// 理由：浮层与兜底小窗在界面上差别很大，出问题时"点了图标但浮层没出来"最难查 ——
// 现在调用方（以及 verify-extension-panel.cjs）能直接拿到"走的是哪条路、为什么"，
// 而不是只看到一个空白结果。
async function togglePanel(tab) {
  if (!tab || tab.id == null) return { ok: false, via: null, reason: '没有可用的标签页' }

  if (!isInjectable(tab.url)) {
    const reason = `这个页面不允许注入（${String(tab.url).split(':')[0]}://…）`
    await openFallbackWindow(reason)
    return { ok: true, via: 'window', reason }
  }

  try {
    // activeTab 是**点图标那一刻**才临时授予的当前标签页权限，
    // 所以这里能注入，而扩展平时对其他网站一无所知（没有 <all_urls>）。
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['overlay.js'],
    })
    return { ok: true, via: 'overlay' }
  } catch (e) {
    // 注入失败的原因不止一种（权限没授上、页面受限、文件被改坏…），
    // 但**任何一种都不该让使用者点了图标什么都没发生** → 一律退回独立小窗。
    const reason = '注入浮层失败：' + ((e && e.message) || e)
    await openFallbackWindow(reason)
    return { ok: false, via: 'window', reason }
  }
}

globalThis.__momentsTogglePanel = togglePanel
globalThis.__momentsRefresh = refresh

// 点扩展图标：先尽量浮层（真毛玻璃），不行再兜底。
// ⚠️ 0.2.0 起 manifest 里**不再有 default_popup** —— 有 popup 时点图标只会开弹窗，
//    onClicked 根本不触发，而且 activeTab 也不会授予。
chrome.action.onClicked.addListener((tab) => { togglePanel(tab) })

// ---------------------------------------------------------------- 定时

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME)
  if (!existing) {
    // MV3 允许的最短周期是 30 秒；用 1 分钟足够，也更省电
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES })
    log('已创建轮询 alarm，周期', POLL_MINUTES, '分钟')
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) refresh()
})

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm()
  refresh()
})

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm()
  refresh()
})

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { [PANEL_WINDOW_KEY]: known } = await chrome.storage.local.get(PANEL_WINDOW_KEY)
  if (known === windowId) await chrome.storage.local.remove(PANEL_WINDOW_KEY)
})

// service worker 被事件唤醒时也跑一次，这样打开浏览器后角标很快就对
ensureAlarm()
refresh()
