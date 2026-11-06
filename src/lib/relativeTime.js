/**
 * 把时间戳变成信息流里那种"短、相对"的写法：
 *   刚刚 / 12 分钟前 / 今天 18:32 / 昨天 19:23 / 9月20日 14:07 / 2025年9月20日 09:12
 *
 * ⚠️ 2026-10-29 使用者："动态再补充一个具体的时间，而不是单单的日期" ——
 *    以前超过一天就只显示「9月20日」，看不出是上午还是晚上。现在**所有超过 1 分钟的时间都带 HH:mm**；
 *    只有"刚刚 / N 分钟前"保持相对写法（那时精确到分钟也没意义）。
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
  if (sameDay) return `今天 ${hhmm}`

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`

  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`
}
