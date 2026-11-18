// 「对方正在输入」（2026-11-16）
//
// 用 Realtime 的 **broadcast**（瞬时消息）：不写数据库、不产生已读/已阅痕迹，断开即消失。
// 只发一个布尔信号（"我在打字"），**消息内容一个字节都不发**。
//
// 三条护栏：
//   · 节流：最快 3 秒一次（连续打字 10 分钟约 200 条广播；免费额度 200 万/月，够用）
//   · 超时：收到后最多显示 5 秒（对方网络断了也不会卡住）
//   · 只在"输入框有内容且聚焦"时发送（翻历史、看消息不发）
const THROTTLE_MS = 3000
const SHOW_MS = 5000
const KEY = 'moments_typing_enabled_v1'

export function isTypingEnabled() {
  try {
    return localStorage.getItem(KEY) !== '0'   // 默认开
  } catch {
    return true
  }
}

export function setTypingEnabled(on) {
  try {
    if (on) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, '0')
  } catch { /* 存不进去也不影响本次会话 */ }
}

/** 一台"发送侧"的节流器：返回 send()，内部自己控制频率 */
export function createTypingSender(channel, meId) {
  let last = 0
  let sent = 0
  return function sendTyping() {
    if (!channel || !meId) return
    if (!isTypingEnabled()) return
    const now = Date.now()
    if (now - last < THROTTLE_MS) return
    last = now
    sent += 1
    // 调试/验收用：挂在 window 上，能数出"到底发了几条广播"
    try { window.__momentsTypingSends = sent } catch { /* 忽略 */ }
    try {
      channel.send({ type: 'broadcast', event: 'typing', payload: { from: meId, at: now } })
    } catch { /* 通道没就绪时忽略 */ }
  }
}

export { THROTTLE_MS, SHOW_MS }
