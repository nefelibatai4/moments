/**
 * 动态时间线的"上次内容"快照（2026-09-30，使用者要求"再快些"）。
 *
 * ── 为什么 ──────────────────────────────────────────────────────
 * 打开应用时最慢的一步是**取动态数据**那一次网络请求（线上实测 300–1000ms，
 * 取决于当时的 Supabase 往返）。用户的感受就是"点开要等一下才有内容"。
 * 这里把上次成功加载的那一页动态存在本地：下次打开**先立刻渲染上次的内容**
 * （通常在 100ms 内），同时后台照旧去取最新数据、拿到后静默替换。
 * 做法上就是最朴素的 stale-while-revalidate。
 *
 * ── 刻意的取舍 ──────────────────────────────────────────────────
 *   * **只缓存动态这一屏**，私聊与消息一律不缓存（那类内容"看到旧的"会误导人）。
 *   * 快照按 **user id** 分开存；登出时全清（换账号不会看到上一个人的内容）。
 *   * 最多 24 小时、最多 20 条：太久/太多就不用了，避免"打开看到几天前的东西"。
 *   * 快照只是"先画出来"，**任何写操作和判断都仍然走后端**（点赞/评论不会被本地状态影响）。
 *   * 存储写失败（隐私模式、配额满）一律静默忽略：缓存永远不该影响功能。
 */

const KEY_PREFIX = 'moments_timeline_v1:'
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_ITEMS = 20
const MAX_BYTES = 300 * 1024

function keyOf(userId) {
  return `${KEY_PREFIX}${userId}`
}

/** 读上次的快照；没有、太旧、坏了都返回 null */
export function readTimelineSnapshot(userId) {
  if (!userId || typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(keyOf(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.uid !== userId || !Array.isArray(parsed.moments)) return null
    if (!parsed.at || Date.now() - parsed.at > MAX_AGE_MS) return null
    return parsed.moments.length > 0 ? parsed.moments : null
  } catch {
    return null
  }
}

/** 存一份快照（只存第一页；失败静默） */
export function writeTimelineSnapshot(userId, moments) {
  if (!userId || typeof localStorage === 'undefined') return
  if (!Array.isArray(moments) || moments.length === 0) return
  try {
    const payload = JSON.stringify({
      uid: userId,
      at: Date.now(),
      moments: moments.slice(0, MAX_ITEMS),
    })
    if (payload.length > MAX_BYTES) return   // 太大就别占地方了
    localStorage.setItem(keyOf(userId), payload)
  } catch {
    /* 存不下就算了 */
  }
}

/** 登出时清掉本机上所有时间线快照（换账号不串内容） */
export function clearTimelineSnapshots() {
  if (typeof localStorage === 'undefined') return
  try {
    const keys = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i)
      if (k && k.startsWith(KEY_PREFIX)) keys.push(k)
    }
    for (const k of keys) localStorage.removeItem(k)
  } catch {
    /* 忽略 */
  }
}
