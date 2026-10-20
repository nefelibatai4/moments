// 本机流量计量（2026-10-20）
//
// 目的：Supabase 后台的 Egress 我们读不到（管理 token 没有 analytics 权限），
// 所以换成"自己数"：把应用发出的每个 HTTP 响应的字节数记下来，按天存本机。
// 对这套应用来说，Egress ≈ 客户端收到的字节数，所以这个数字很接近服务端账单，
// 区别只是"每台设备各自统计"。
//
// 三个刻意的设计：
//   · 只数**真的走了网络**的响应（命中本机媒体缓存时压根不发请求，天然不计数）
//   · 用 `response.clone()` 读字节，不干扰调用方的 body
//   · 数字存 localStorage（按天，保留 31 天），换设备各算各的

const KEY = 'moments_traffic_v1'
const KEEP_DAYS = 31

const listeners = new Set()
let installed = false
let currentWrapped = null   // 上一次包住的那个 fetch（被别的库换掉后要重新包）
let todayCache = null

const pad = (n) => String(n).padStart(2, '0')

/** 按北京时间的"日"归属（跨时区设备也能对到同一天） */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function monthKey(ts = Date.now()) {
  return dayKey(ts).slice(0, 7)
}

function read() {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const rows = JSON.parse(raw)
    return Array.isArray(rows) ? rows.filter((r) => r && r.day && Number.isFinite(r.bytes)) : []
  } catch {
    return []
  }
}

function write(rows) {
  const cutoff = dayKey(Date.now() - KEEP_DAYS * 86400000)
  const kept = rows.filter((r) => r.day >= cutoff)
  try {
    window.localStorage.setItem(KEY, JSON.stringify(kept))
  } catch {
    /* 隐私模式没有 localStorage：内存里记着，刷新就没了 */
  }
}

/** 记一笔（字节）。同一天累加。 */
export function addBytes(bytes, ts = Date.now()) {
  if (!Number.isFinite(bytes) || bytes <= 0) return
  const day = dayKey(ts)
  const rows = read()
  const row = rows.find((r) => r.day === day)
  if (row) row.bytes += bytes
  else rows.push({ day, bytes })
  write(rows)
  if (todayCache?.day === day) todayCache.bytes += bytes
  for (const cb of listeners) { try { cb() } catch { /* 订阅方自己的错 */ } }
}

/** 汇总：今天 / 本月 / 近 31 天 / 每日明细 */
export function trafficSummary(now = Date.now()) {
  const rows = read()
  const today = dayKey(now)
  const month = monthKey(now)
  const sum = (fn) => rows.reduce((acc, r) => (fn(r) ? acc + r.bytes : acc), 0)
  return {
    today: sum((r) => r.day === today),
    month: sum((r) => r.day.startsWith(month)),
    all: sum(() => true),
    days: rows.slice().sort((a, b) => (a.day < b.day ? 1 : -1)),
  }
}

/** 清空（退出登录时用） */
export function clearTraffic() {
  try {
    window.localStorage.removeItem(KEY)
  } catch { /* 忽略 */ }
  todayCache = null
  for (const cb of listeners) { try { cb() } catch { /* 忽略 */ } }
}

/** 订阅变化（页面里用来实时刷新数字） */
export function onTrafficChange(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** 从响应里把字节数读出来（不消费原 body） */
async function measure(res) {
  try {
    const len = Number(res.headers.get('content-length'))
    if (Number.isFinite(len) && len > 0) return len
    const buf = await res.clone().arrayBuffer()
    return buf.byteLength
  } catch {
    return 0
  }
}

/**
 * 装一次：包住 window.fetch 做计量。
 * 完全不改变请求/响应本身，出错也只是"这一笔记不上"。
 */
export function installTrafficMeter() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return
  // 已经是我们的包装、而且外面没人再换过 → 不重复包（否则会一层套一层）
  if (installed && window.fetch === currentWrapped) return
  installed = true
  const original = window.fetch.bind(window)
  window.fetch = async (...args) => {
    const res = await original(...args)
    try {
      if (res?.ok) {
        const bytes = await measure(res)
        addBytes(bytes)
      }
    } catch {
      /* 计量失败不影响业务 */
    }
    return res
  }
  currentWrapped = window.fetch
}
