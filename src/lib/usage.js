// 服务器侧用量（2026-10-20）
//
// 能读到的：数据库大小、媒体占用、动态/消息条数 —— 走数据库里的 `app_usage()` 函数
//         （security definer，只有已激活账号能调；见 db-backups/20261020_app_usage_rpc.sql）
// 读不到的：Supabase 的出站流量配额（管理 token 没有 analytics 权限）→ 只能用本机实测近似
import { supabase } from '../supabaseClient'

/**
 * @returns {Promise<{ ok: boolean, reason?: string, dbBytes?: number, mediaBytes?: number,
 *   mediaObjects?: number, moments?: number, messages?: number, at?: number }>}
 */
export async function fetchServerUsage() {
  try {
    const { data, error } = await supabase.rpc('app_usage')
    if (error) return { ok: false, reason: error.message }
    const d = data ?? {}
    return {
      ok: true,
      dbBytes: Number(d.db_bytes ?? 0),
      mediaBytes: Number(d.media_bytes ?? 0),
      mediaObjects: Number(d.media_objects ?? 0),
      moments: Number(d.moments ?? 0),
      messages: Number(d.messages ?? 0),
      at: Date.now(),
    }
  } catch (err) {
    return { ok: false, reason: err?.message ?? 'unavailable' }
  }
}

/** 人类可读的体积 */
export function humanBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / 1048576).toFixed(1)} MB`
  return `${(v / 1073741824).toFixed(2)} GB`
}
