// 隐身预览模式（2026-11-12，改为**跟账号走**）
//
// 使用者要求：打开会话时**不写已读**（对方不会看到 ✓✓），入口只对他自己开放；
// 并且"M 上开了，手机也要一致" → 所以设置存在**服务器**（`user_settings.peek_mode`），不再存本机。
//
// 三个刻意的取舍：
//   · 白名单 `PEEK_ALLOWED_IDS`：入口只对使用者本人渲染，对方完全看不到这个功能；
//   · 只有本人能读写的表（RLS），连对方都读不到这个偏好；
//   · 模块里留一份内存缓存 → 聊天页同步判断"要不要标已读"，启动时/进会话前 `ensurePeekLoaded()`。
import { supabase } from '../supabaseClient'

/** 只有这个账号能看到入口 / 使用该模式（= 使用者本人） */
export const PEEK_ALLOWED_IDS = ['ab9bad7c-cb66-4e98-afba-856775d23698']

const listeners = new Set()
let cached = false            // 当前值（未加载时按"关"处理）
let loadedFor = null          // 已为哪个账号加载过
let loading = null            // 去重：并发调用只发一次请求

export function isPeekAllowed(user) {
  if (!user?.id) return false
  try {
    if (typeof window !== 'undefined' && window.__PEEK_ALLOW_ANY__ === true) return true
  } catch { /* 忽略 */ }
  return PEEK_ALLOWED_IDS.includes(user.id)
}

/** 同步读当前值（聊天页标记已读前用；未加载时视为关闭） */
export function isPeekOn() {
  return cached === true
}

export function onPeekChange(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function apply(next) {
  cached = next === true
  for (const cb of listeners) { try { cb(cached) } catch { /* 订阅方自己的错 */ } }
}

/** 从服务器加载（每个账号一次；失败就保持关闭，不影响任何功能） */
export async function ensurePeekLoaded(userId) {
  if (!userId) return false
  if (loadedFor === userId) return cached
  if (loading) return loading
  loading = (async () => {
    try {
      const { data, error } = await supabase
        .from('user_settings')
        .select('peek_mode')
        .eq('user_id', userId)
        .maybeSingle()
      if (!error) {
        loadedFor = userId
        apply(data?.peek_mode === true)
      }
    } catch { /* 读不到就当关闭 */ } finally {
      loading = null
    }
    return cached
  })()
  return loading
}

/** 写回服务器（乐观更新：先改界面，失败再回滚） */
export async function setPeekOn(userId, next) {
  if (!userId) return false
  const previous = cached
  apply(next === true)
  loadedFor = userId
  try {
    const { error } = await supabase
      .from('user_settings')
      .upsert({ user_id: userId, peek_mode: next === true, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    if (error) {
      apply(previous)
      return false
    }
    return true
  } catch {
    apply(previous)
    return false
  }
}
