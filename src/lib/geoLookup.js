import { supabase } from '../supabaseClient'

/**
 * 登录位置（城市级）—— 2026-10-12 使用者要求"在【我】里看登录过的账号的位置"。
 *
 * ⚠️ 先说清楚这是什么：**IP 定位只能到城市**（误差几公里到几十公里；VPN / 运营商出口还会更离谱）。
 *    它不是"精确位置"。真正的精确经纬度要设备定位权限（iOS 上还必须应用在前台），
 *    使用者明确选了"只要 IP 城市级"，所以这里只做 IP → 城市 + 大致坐标。
 *
 * 数据从哪来：
 *   · IP / 国家 / 设备 由服务端的 `touch_session()` 从请求头写入 `device_locations`
 *     （cf-connecting-ip 是 Cloudflare 写的，浏览器伪造不了）
 *   · 城市 + 经纬度：管理员打开【我】时在这里补全，结果缓存进 `ip_geo_cache`
 *     —— **同一个 IP 只向地理库查一次**（少暴露、也快）
 *
 * 隐私说明：解析时会把 IP 发给第三方地理库（ipwho.is）。这是 IP 定位绕不开的一步。
 */

const PROVIDER = 'ipwho.is'
const PRIVATE_IP = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd])/i

export function isResolvableIp(ip) {
  if (!ip || typeof ip !== 'string') return false
  if (PRIVATE_IP.test(ip.trim())) return false
  return /^[0-9a-f.:]+$/i.test(ip.trim())
}

async function fetchGeo(ip) {
  try {
    const res = await fetch(`https://${PROVIDER}/${encodeURIComponent(ip)}`, { headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const j = await res.json()
    if (!j?.success || j.latitude == null || j.longitude == null) return null
    return {
      city: j.city || null,
      region: j.region || null,
      country: j.country_code || j.country || null,
      lat: j.latitude,
      lng: j.longitude,
    }
  } catch {
    return null
  }
}

/**
 * 读位置轨迹，并把还没解析过的 IP 解析出来（写进缓存）。
 * @returns {Promise<{rows: Array, geo: Map<string, object>, resolved: number}>}
 */
export async function loadLocationFeed(limit = 200) {
  const { data: rows, error } = await supabase
    .from('device_locations')
    .select('id, user_id, ip, country, device, source, lat, lng, accuracy_m, captured_at')
    .order('captured_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)

  const { data: cacheRows } = await supabase.from('ip_geo_cache').select('*')
  const geo = new Map((cacheRows ?? []).map((r) => [r.ip, r]))

  // 还没解析过的公网 IP（去重）
  const missing = [...new Set((rows ?? []).map((r) => r.ip).filter((ip) => isResolvableIp(ip) && !geo.has(ip)))]
  let resolved = 0
  for (const ip of missing) {
    const g = await fetchGeo(ip)
    if (!g) continue
    const row = { ip, ...g, provider: PROVIDER, resolved_at: new Date().toISOString() }
    const { error: upErr } = await supabase.from('ip_geo_cache').upsert(row)
    if (!upErr) { geo.set(ip, row); resolved += 1 }
  }

  return { rows: rows ?? [], geo, resolved }
}

/**
 * 一条记录最终展示用的坐标：
 *   · GPS 行（source='gps'）用**设备自己报的**精确坐标（米级）
 *   · 其余用 IP 地理库解析出来的城市级坐标
 */
export function effectivePosition(row, geoRow) {
  if (row?.source === 'gps' && row.lat != null && row.lng != null) {
    return { lat: row.lat, lng: row.lng, accuracy_m: row.accuracy_m, precision: 'gps' }
  }
  if (geoRow?.lat != null && geoRow?.lng != null) {
    return { lat: geoRow.lat, lng: geoRow.lng, accuracy_m: null, precision: 'city' }
  }
  return null
}

/** 地图链接：城市级用坐标搜，没坐标就用城市名搜 */
export function mapLinks(row, geoRow) {
  const pos = effectivePosition(row, geoRow)
  const lat = pos?.lat
  const lng = pos?.lng
  const label = [geoRow?.city, geoRow?.region, geoRow?.country].filter(Boolean).join(' ')
  if (lat != null && lng != null) {
    return {
      apple: `https://maps.apple.com/?ll=${lat},${lng}&q=${encodeURIComponent(label || '位置')}`,
      google: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
      label: pos?.precision === 'gps' ? `精确位置（±${pos.accuracy_m ? Math.round(pos.accuracy_m) : '?'} 米）` : (label || `${lat}, ${lng}`),
      coords: pos?.precision === 'gps'
        ? `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`
        : `${Number(lat).toFixed(3)}, ${Number(lng).toFixed(3)}`,
      precision: pos?.precision ?? 'city',
      accuracy_m: pos?.accuracy_m ?? null,
      city: label,
    }
  }
  const q = encodeURIComponent(label || row.country || row.ip || '')
  return q
    ? { apple: `https://maps.apple.com/?q=${q}`, google: `https://www.google.com/maps/search/?api=1&query=${q}`, label: label || row.country || '未知', coords: null }
    : null
}
