// Moments 扩展的 background service worker
//
// 职责只有三件：
//   1. 持有会话（从网页同步来的，见 content.js），必要时刷新 access token；
//   2. 定期查未读私信数，写到工具栏角标上；
//   3. 给 popup 提供当前状态。
//
// ⚠️ MV3 最重要的限制：service worker 空闲约 30 秒就会被回收，
// 所以这里**不能用长连接**（Supabase Realtime 的 websocket 撑不住）。
// 保底且可靠的做法是 chrome.alarms 定时轮询——alarms 能把被回收的 worker 唤醒。
// 系统通知那一层不需要这里操心：网页版的 Web Push 已经在做，而且是全局的。

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'

const ALARM_NAME = 'moments-poll'
const POLL_MINUTES = 1
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
  if (msg && msg.type === 'status:get') {
    chrome.storage.local.get('status').then(({ status }) => sendResponse(status || null))
    return true
  }
  return false
})

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

// service worker 被事件唤醒时也跑一次，这样打开浏览器后角标很快就对
ensureAlarm()
refresh()
