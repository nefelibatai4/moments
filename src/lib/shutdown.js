// 「网站关闭」开关（2026-10-18 使用者要求的临时状态）
//
// 使用者原话：前端只显示一个关闭倒计时，关闭时间 = 明天 24 点（即 2026-10-19 24:00
// = 2026-10-20 00:00 北京时间）；后端数据**一条不动**。
//
// 所以这里只做一件事：拦住前端渲染。数据库、存储桶、账号、消息**全部保留**，
// 没有删除、没有迁移、没有定时任务。
//
// 想恢复原样：把 `SHUTDOWN_ENABLED` 改回 false（或者 `git revert` 这一个提交）。
export const SHUTDOWN_ENABLED = true

// 明确写 +08:00，避免用设备本地时区（两个人在不同时区看到的时间才会一致）
export const SHUTDOWN_AT = new Date('2026-10-20T00:00:00+08:00')

/** 现在是否已经过了关闭时间 */
export function isShutdownPassed(now = Date.now()) {
  return now >= SHUTDOWN_AT.getTime()
}
