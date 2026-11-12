// 未读提示的展示方式（2026-11-12）
//
// 三种：number（数字角标，默认）/ dot（只一个小圆点）/ tint（图标本身变色）
// 选择存在本机（内容偏好，不适合跟账号走 —— 同一个账号在手机插件和电脑插件上可能想不一样），
// 同时通过 content.js 转给扩展（`unreadStyle:set`）。
const KEY = 'moments_unread_style_v1'

export const UNREAD_STYLES = [
  { key: 'number', label: '数字角标', hint: '图标右上角显示未读条数（默认）' },
  { key: 'dot', label: '小红点', hint: '只标记"有未读"，不显示数字' },
  { key: 'tint', label: '图标变色', hint: '有未读时图标本身变成红色' },
]

export function getUnreadStyle() {
  try {
    const v = localStorage.getItem(KEY)
    return UNREAD_STYLES.some((s) => s.key === v) ? v : 'number'
  } catch {
    return 'number'
  }
}

function announce(value) {
  try {
    window.postMessage({ source: 'moments-app', type: 'unread-style', value }, '*')
  } catch { /* 忽略 */ }
}

export function setUnreadStyle(value) {
  if (!UNREAD_STYLES.some((s) => s.key === value)) return
  try {
    localStorage.setItem(KEY, value)
  } catch { /* 存不进去也不影响本次下发 */ }
  announce(value)
}

/** 启动时下发一次，保证扩展和我们一致（扩展自己也有持久化，这一步只是"对齐"） */
export function announceUnreadStyle() {
  announce(getUnreadStyle())
}
