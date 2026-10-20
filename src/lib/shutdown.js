// 「网站关闭」开关（2026-10-18 使用者要求的临时状态）
//
// ⚠️ 2026-10-18 晚：**已关闭**（两人和好，使用者要求恢复站点）。代码保留，将来要再关只需改回 true。
//
// 使用者原话：前端只显示一个关闭倒计时，关闭时间 = 明天 24 点（即 2026-10-19 24:00
// = 2026-10-20 00:00 北京时间）；后端数据**一条不动**。
//
// 所以这里只做一件事：拦住前端渲染。数据库、存储桶、账号、消息**全部保留**，
// 没有删除、没有迁移、没有定时任务。
//
// 想恢复原样：把 `SHUTDOWN_ENABLED` 改回 false（或者 `git revert` 这一个提交）。
export const SHUTDOWN_ENABLED = false

// 明确写 +08:00，避免用设备本地时区（两个人在不同时区看到的时间才会一致）
export const SHUTDOWN_AT = new Date('2026-10-20T00:00:00+08:00')

// 起点：两人在一起的那天（使用者 2026-10-18 指定"从 6 月 27 日开始算"）。
// 关闭页上"运行时长"就是按这个算的 —— 在它看来，网站的运行时间 = 他们在一起的时间。
export const TOGETHER_START = new Date('2026-06-27T00:00:00+08:00')

/** 一起走过多少天（含首尾：6/27 → 10/20 = 115 天） */
export function daysTogether(until = SHUTDOWN_AT) {
  const ms = until.getTime() - TOGETHER_START.getTime()
  return Math.max(0, Math.round(ms / 86400000))
}

/** 现在是否已经过了关闭时间 */
export function isShutdownPassed(now = Date.now()) {
  return now >= SHUTDOWN_AT.getTime()
}
