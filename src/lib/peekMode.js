// 隐身预览模式（2026-11-12）
//
// 使用者要求：打开会话时**不写已读**（对方不会看到 ✓✓），并且**入口只对他自己开放**。
// 之所以做成"全局开关"而不是会话页里的按钮：已读是**打开会话那一瞬间**写进去的，
// 会话页里的开关来不及生效（那时已经标过了）。
//
// 三个刻意的取舍：
//   · **只对指定账号显示入口**（PEEK_ALLOWED_IDS）：对方在任何地方都看不到这个功能；
//   · 开关存在本机（`localStorage`），**换设备不跟随** —— 它是个"当下这个设备怎么表现"的选择；
//   · 开着的时候会话页顶部有常驻提示，避免"忘了关"造成误会。

/** 只有这个账号能看到入口 / 使用该模式（= 使用者本人） */
export const PEEK_ALLOWED_IDS = ['ab9bad7c-cb66-4e98-afba-856775d23698']

const KEY = 'moments_peek_mode_v1'

/** 这个账号是否被允许使用隐身预览（测试里可以用 window.__PEEK_ALLOW_ANY__ 放行） */
export function isPeekAllowed(user) {
  if (!user?.id) return false
  try {
    if (typeof window !== 'undefined' && window.__PEEK_ALLOW_ANY__ === true) return true
  } catch { /* 忽略 */ }
  return PEEK_ALLOWED_IDS.includes(user.id)
}

export function isPeekOn() {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setPeekOn(on) {
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
    /* 存不进去也不影响本次会话内的判断 */
  }
}
