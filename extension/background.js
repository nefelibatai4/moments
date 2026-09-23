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
const PANEL_DEFAULT_SETTINGS = { mode: 'glass', tint: 'theme', blur: 12 }
const BADGE_COLOR = '#ff6363' // 与 app 的 --accent-red 一致
const BADGE_MAX = 99

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
// 角标口径 = **未读私信**（messages.read_at 为空）。
// 动态/评论/点赞那几张表没有「已读」概念，统计不准，所以不纳入口径。
async function fetchUnreadCount(userId, accessToken) {
  const url =
    `${SUPABASE_URL}/rest/v1/messages` +
    `?select=id&recipient_id=eq.${encodeURIComponent(userId)}&read_at=is.null&limit=${BADGE_MAX + 1}`

  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (res.status === 401) return { error: 'unauthorized' }
  if (!res.ok) return { error: `http ${res.status}` }

  const rows = await res.json()
  return { count: Array.isArray(rows) ? rows.length : 0 }
}

// ---------------------------------------------------------------- 角标

async function paintBadge(count) {
  const text = !count ? '' : count > BADGE_MAX ? `${BADGE_MAX}+` : String(count)
  await chrome.action.setBadgeText({ text })
  if (text) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR })
  // 设置 title 让鼠标悬停能看到完整数字（角标位置太窄，99+ 会挤）
  await chrome.action.setTitle({
    title: text ? `Moments 私密圈 · ${count} 条未读私信` : 'Moments 私密圈',
  })
}

async function setStatus(patch) {
  const { status } = await chrome.storage.local.get('status')
  await chrome.storage.local.set({ status: { ...(status || {}), ...patch } })
}

// ---------------------------------------------------------------- 主流程

async function refresh() {
  const session = await getSession()
  if (!session || !session.user_id) {
    await paintBadge(0)
    await setStatus({ hasSession: false, unread: 0, lastChecked: Date.now(), lastError: null })
    return
  }

  try {
    const token = await ensureFreshToken(session)
    if (!token) {
      await paintBadge(0)
      await setStatus({ hasSession: false, unread: 0, lastChecked: Date.now(), lastError: '会话已失效' })
      return
    }

    const { count, error } = await fetchUnreadCount(session.user_id, token)
    if (error) {
      // 401 说明会话在别处失效了，清掉等重新同步；其他错误保留会话重试
      if (error === 'unauthorized') await clearSession()
      await setStatus({ hasSession: error !== 'unauthorized', unread: 0, lastChecked: Date.now(), lastError: error })
      if (error === 'unauthorized') await paintBadge(0)
      return
    }

    await paintBadge(count)
    await setStatus({ hasSession: true, unread: count, lastChecked: Date.now(), lastError: null })
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
  if (msg && msg.type === 'panel:settings') {
    // content.js 转交来的网页设置：存下来，浮层通过 storage.onChanged 自动跟上
    setPanelSettings(msg.settings, msg.theme).finally(() => sendResponse({ ok: true }))
    return true
  }
  if (msg && msg.type === 'panel:getSettings') {
    getPanelSettings().then((res) => sendResponse(res))
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
  const { panelBg, panelTheme } = await chrome.storage.local.get(['panelBg', 'panelTheme'])
  return {
    settings: { ...PANEL_DEFAULT_SETTINGS, ...(panelBg || {}) },
    theme: panelTheme || 'dark',
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

async function togglePanel(tab) {
  if (!tab || tab.id == null) return

  if (!isInjectable(tab.url)) {
    await openFallbackWindow(`这个页面不允许注入（${String(tab.url).split(':')[0]}://…）`)
    return
  }

  try {
    // activeTab 是**点图标那一刻**才临时授予的当前标签页权限，
    // 所以这里能注入，而扩展平时对其他网站一无所知（没有 <all_urls>）。
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['overlay.js'],
    })
  } catch (e) {
    // 注入失败的原因不止一种（权限没授上、页面受限、文件被改坏…），
    // 但**任何一种都不该让使用者点了图标什么都没发生** → 一律退回独立小窗。
    await openFallbackWindow('注入浮层失败：' + ((e && e.message) || e))
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
