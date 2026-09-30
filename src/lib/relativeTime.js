/**
 * 把时间戳变成信息流里那种"短、相对"的写法（微博/微信都是这样）：
 *   刚刚 / 12 分钟前 / 3 小时前 / 昨天 19:23 / 9月20日 / 2025年9月20日
 *
 * 为什么不用 `toLocaleString` 的完整时间（原实现）：
 * 手机端卡片头只有一行位置，"2026/9/30 14:17:18" 会把昵称挤到换行，
 * 信息流看上去就散（使用者 2026-09-30 要做成微博那种紧凑信息流）。
 * 需要精确时间时点开动态详情/评论里看即可（评论里仍是完整时间）。
 *
 * @param {string|number|Date} iso
 * @param {Date} [now] 便于测试注入"现在"
 */
export function relativeTime(iso, now = new Date()) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diff = now.getTime() - d.getTime()
  const min = Math.floor(diff / 60000)

  if (diff < 0) return '刚刚'                      // 时钟偏差导致的"未来时间"也当刚刚
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`

  const sameDay = d.toDateString() === now.toDateString()
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay) return `${Math.floor(min / 60)} 小时前`

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`

  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}
