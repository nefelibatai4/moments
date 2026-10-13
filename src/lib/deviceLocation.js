import { supabase } from '../supabaseClient'

/**
 * 设备精确定位上报（第 2 档，2026-10-12）。
 *
 * 能力边界（界面上也是这么写的，别让它听起来比实际更强）：
 *   · 精度通常 **5–50 米**（室外 GPS）；室内靠 Wi-Fi 定位可能 20–100 米
 *   · **只有应用在前台打开着**才拿得到；iOS 上关掉应用/锁屏后网页拿不到位置
 *   · 必须**自己授权**（手机弹一次"允许获取位置"），默认关闭、随时可关
 *
 * 做法：默认关闭 → 打开开关时立刻要一次权限并上报一次 → 之后每次打开应用最多再报一次
 * （10 分钟内不重复报，免得每次切页面都打一次网络）。
 */

const ENABLED_KEY = 'moments_location_report_v1'
const LAST_SENT_KEY = 'moments_location_last_sent_v1'
const MIN_INTERVAL_MS = 10 * 60 * 1000

export function isLocationReportingEnabled() {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

export function setLocationReportingEnabled(on) {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, '1')
    else localStorage.removeItem(ENABLED_KEY)
  } catch { /* 存不下就当没开 */ }
  if (!on) {
    try { localStorage.removeItem(LAST_SENT_KEY) } catch { /* 忽略 */ }
  }
}

function lastSentAt() {
  try {
    return Number(localStorage.getItem(LAST_SENT_KEY) || 0)
  } catch {
    return 0
  }
}

function markSent() {
  try {
    localStorage.setItem(LAST_SENT_KEY, String(Date.now()))
  } catch { /* 忽略 */ }
}

/** 浏览器定位能力是否可用 */
export function canUseGeolocation() {
  return typeof navigator !== 'undefined' && !!navigator.geolocation
}

/**
 * 要一次位置并上报。
 * @param {{ force?: boolean }} opts force=true 时忽略 10 分钟节流（用户手动点"立即上报"）
 * @returns {Promise<{ok: boolean, reason?: string, lat?: number, lng?: number, accuracy?: number}>}
 */
export async function reportPreciseLocation({ force = false } = {}) {
  if (!canUseGeolocation()) return { ok: false, reason: '这个浏览器不支持定位' }
  if (!force) {
    if (!isLocationReportingEnabled()) return { ok: false, reason: '未开启' }
    if (Date.now() - lastSentAt() < MIN_INTERVAL_MS) return { ok: false, reason: '刚刚报过' }
  }

  let position
  try {
    position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 60000,
      })
    })
  } catch (err) {
    // 1=未授权 2=拿不到（室内/无信号） 3=超时
    const map = { 1: '你拒绝了定位授权（可在浏览器设置里改）', 2: '暂时拿不到位置（室内或没信号）', 3: '定位超时' }
    return { ok: false, reason: map[err?.code] || '定位失败' }
  }

  const lat = position.coords.latitude
  const lng = position.coords.longitude
  const accuracy = Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null

  const { error } = await supabase.rpc('report_device_location', {
    p_lat: lat,
    p_lng: lng,
    p_accuracy: accuracy,
  })
  if (error) return { ok: false, reason: error.message }

  markSent()
  return { ok: true, lat, lng, accuracy }
}
