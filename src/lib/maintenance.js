// 「维护中」页面开关（2026-10-20）
//
// 背景：Supabase 免费额度（出站流量 5 GB）本月用了 23.4 GB → 项目被判超标，
// 所有 API 返回 402，站点进去也读不到数据。账单周期 9/21–10/21，
// 预计 **2026-10-21 08:00（北京时间，= UTC 00:00）** 归零后自动解封。
//
// 这个开关只做一件事：把首屏换成"维护中 + 预计恢复时间 + 倒计时"。
// **后端数据一条不动**，也没有任何迁移/删除动作。
//
// 两个刻意的设计：
//   ① **探活**：页面启动时用 anon key 打一次 `/auth/v1/settings`（几百字节）：
//      200 → 直接进正常应用（服务恢复了，不需要我改代码重新发布）；
//      402/其它 → 显示维护页，并在后台每 30 秒探一次，恢复后自动进入。
//   ② 到了预计时间还没恢复 → 文案变成"正在等待恢复"，继续等，不装作没事。
export const MAINTENANCE_ENABLED = true

// 预计恢复时间：后台 Billing 页原文 ——
//   "wait until the start of your next billing period. Note that there may be a short delay
//    of up to 1 hour for the restrictions to be lifted. Wait for the period to reset at your
//    next billing period which is Oct 22."
// 也就是 **2026-10-22** 进入新周期，解除最多再延迟 1 小时 → 按 09:00（+08:00）估。
export const MAINTENANCE_UNTIL = Date.parse('2026-10-22T09:00:00+08:00')

/** 探活间隔（毫秒） */
export const PROBE_INTERVAL_MS = 30_000

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * 后端是不是活着。
 * @returns {Promise<{ ok: boolean, status: number|null }>}
 *   `status === 402` 就是"额度超标被限制"，其余非 200 一概按未恢复处理。
 */
export async function probeBackend({ timeoutMs = 8000 } = {}) {
  if (!SUPABASE_URL) return { ok: false, status: null }
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: SUPABASE_ANON },
      signal: ctrl?.signal,
      cache: 'no-store',
    })
    return { ok: res.status === 200, status: res.status }
  } catch {
    return { ok: false, status: null }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
