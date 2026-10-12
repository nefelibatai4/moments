import { supabase } from '../supabaseClient'

/**
 * 私聊的两层缓存（2026-09-30，使用者："点私聊出现一次加载中，进会话又出现一次，能省掉吗"）。
 *
 * 那两次"加载中"各自是真实存在的网络请求，**省不掉**（数据得从服务器来）：
 *   ① 私聊列表：联系人 profiles + 最近 500 条消息 + 未读消息（三个并行）
 *   ② 会话详情：对方资料 + 最近 50 条消息（两个并行）
 * 但可以让用户**看不到等待** —— 和动态页同样的思路：
 *   * **列表**：把上次的结果存在本地（localStorage），下次进列表先画出来再后台刷新。
 *     列表里只有"昵称 + 头像 + 最后一条的摘要 + 未读数"，属于索引类信息。
 *   * **会话**：只在**内存**里缓存（不落盘）。理由是消息内容比列表敏感，
 *     而且"看到旧消息却以为是新的"比列表严重；内存缓存已经能覆盖
 *     "返回列表→再进同一个人"和"悬停预取"这两种最常见的情况，刷新页面即失效。
 *   * **预取**：鼠标悬停/手指按下就先把这个会话拉进内存，点进去时通常已经好了。
 */

const LIST_KEY_PREFIX = 'moments_chatlist_v1:'
const LIST_MAX_AGE_MS = 6 * 60 * 60 * 1000
const LIST_MAX_ITEMS = 50

function listKey(userId) {
  return `${LIST_KEY_PREFIX}${userId}`
}

/** 列表快照：读（没有/太旧/坏掉都返回 null） */
export function readChatListSnapshot(userId) {
  if (!userId || typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(listKey(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.uid !== userId || !Array.isArray(parsed.conversations)) return null
    if (!parsed.at || Date.now() - parsed.at > LIST_MAX_AGE_MS) return null
    return parsed.conversations.length > 0 ? parsed.conversations : null
  } catch {
    return null
  }
}

/** 列表快照：写（失败静默） */
export function writeChatListSnapshot(userId, conversations) {
  if (!userId || typeof localStorage === 'undefined') return
  if (!Array.isArray(conversations) || conversations.length === 0) return
  try {
    localStorage.setItem(listKey(userId), JSON.stringify({
      uid: userId,
      at: Date.now(),
      conversations: conversations.slice(0, LIST_MAX_ITEMS),
    }))
  } catch {
    /* 存不下就算了 */
  }
}

/** 登出时清掉列表快照（会话缓存只在内存，随页面一起没了） */
export function clearChatListSnapshots() {
  if (typeof localStorage === 'undefined') return
  try {
    const keys = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i)
      if (k && k.startsWith(LIST_KEY_PREFIX)) keys.push(k)
    }
    for (const k of keys) localStorage.removeItem(k)
  } catch {
    /* 忽略 */
  }
  threadCache.clear()
}

// ── 会话（内存）缓存 ─────────────────────────────────────────────
// 键 = `${me}|${peer}`；只留最近用到的几个会话，避免长时间使用后占内存。
const threadCache = new Map()
const THREAD_CACHE_MAX = 6

function threadKey(me, peer) {
  return `${me}|${peer}`
}

/** 读内存里的会话（返回 { profile, messages } 或 null） */
export function readCachedThread(me, peer) {
  if (!me || !peer) return null
  const hit = threadCache.get(threadKey(me, peer))
  if (!hit) return null
  // 重新置一次，让它排在"最近使用"的最后（下面的淘汰按插入顺序）
  threadCache.delete(threadKey(me, peer))
  threadCache.set(threadKey(me, peer), hit)
  return hit
}

/** 写内存里的会话 */
export function writeCachedThread(me, peer, data) {
  if (!me || !peer || !data) return
  const key = threadKey(me, peer)
  threadCache.delete(key)
  threadCache.set(key, data)
  while (threadCache.size > THREAD_CACHE_MAX) {
    threadCache.delete(threadCache.keys().next().value)
  }
}

/** 会话详情的两段查询（load 和 prefetch 共用，保证两边拿到的形状一致） */
export async function fetchThreadData(me, peer, pageSize = 50) {
  const [profileRes, messagesRes] = await Promise.all([
    supabase.from('profiles').select('id, nickname, avatar_url, public_key').eq('id', peer).single(),
    supabase
      .from('messages')
      .select('*')
      .or(`and(sender_id.eq.${me},recipient_id.eq.${peer}),and(sender_id.eq.${peer},recipient_id.eq.${me})`)
      .order('created_at', { ascending: false })
      .limit(pageSize),
  ])
  if (profileRes.error || messagesRes.error) return null
  const page = messagesRes.data ?? []
  return { profile: profileRes.data, messages: page.slice().reverse(), pageLength: page.length }
}

/**
 * 预取一个会话进内存（悬停/按下时调用）。
 * 已经在缓存里就不再请求；失败静默（点进去时照常会自己加载）。
 */
export function prefetchThread(me, peer, pageSize = 50) {
  if (!me || !peer) return
  if (readCachedThread(me, peer)) return
  fetchThreadData(me, peer, pageSize)
    .then((data) => { if (data) writeCachedThread(me, peer, data) })
    .catch(() => { /* 预取失败无所谓 */ })
}
