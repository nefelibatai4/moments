/**
 * 私聊工作区的轻量事件总线（侧栏 ← 会话页）。
 *
 * 为什么不用 Context 把 ChatList 和 ChatThread 串起来：
 * 两者是**兄弟**（一个在 aside、一个在 keyed Outlet），Context 只能从外壳往下传，
 * 而"已读"是子页 → 侧栏的反向消息。用一个进程内的事件总线最小：
 *   · ChatThread 写完 read_at → notifyConversationRead(peerId)
 *   · GroupThread markGroupSeen → notifyGroupSeen(threadId)（在 lib/groupChat 里统一发）
 *   · 常驻的 ChatList 订阅后，立刻把对应行的角标本地清零，不等 Realtime 往返。
 *
 * 事件只是"界面提示"，不是数据源：真正的未读数仍以数据库/本机 seen 记录为准，
 * 下一页全量加载或 Realtime 刷新会把它校正回来。
 */
const listeners = new Set()

export function subscribeChatLive(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function emit(event) {
  for (const listener of [...listeners]) {
    try { listener(event) } catch { /* 单个订阅者出错不能影响其它人 */ }
  }
}

/** 某个私聊会话已经读到最新（侧栏角标应立即清零） */
export function notifyConversationRead(peerId) {
  if (!peerId) return
  emit({ type: 'conversation-read', peerId })
}

/** 某个群已经看到最新（侧栏群行角标应立即清零） */
export function notifyGroupSeen(threadId) {
  if (!threadId) return
  emit({ type: 'group-seen', threadId })
}
