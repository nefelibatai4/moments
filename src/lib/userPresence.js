import { supabase } from '../supabaseClient'

/**
 * 记录"上次访问时间 / IP / 设备"（管理员界面要看的那些）。
 *
 * ⚠️ 数据**全部由服务端从请求头取**（见 db-backups/20260924_admin_and_presence.sql 的
 *    touch_session()）：客户端只负责"叫一声"。所以这些字段伪造不了，
 *    也不需要前端做任何隐私相关的取舍。
 *
 * 节流：同一次浏览器会话里最多 5 分钟写一次。应用每次加载（含插件面板）都会启动，
 * 不节流的话每开一次面板就写一次库，没必要。
 */
const THROTTLE_MS = 5 * 60 * 1000
const KEY = 'moments_last_touch'

export async function touchSession() {
  try {
    const last = Number(localStorage.getItem(KEY)) || 0
    if (Date.now() - last < THROTTLE_MS) return
    localStorage.setItem(KEY, String(Date.now()))
  } catch {
    // 存储不可用也照发（只是少一层节流）
  }
  try {
    await supabase.rpc('touch_session')
  } catch {
    // 记录失败不影响任何功能
  }
}
