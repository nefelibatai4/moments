// 「现在就让使用者输一次密码」的信号（2026-10-28）
//
// 场景：使用者在这台设备上登录了，但钥匙材料不在本机（面板 iframe 的存储是隔离的、
// 或之前点过「稍后」）。此时内容一律读不到，而唯一的入口是那张会自己冒出来的提示卡 ——
// 一旦它因为"稍后"或时机问题没出现，使用者就会卡在"我明明登录了，为什么读不到"。
//
// 所以给别处一个主动唤起它的办法：读不到内容的地方显示一句可点的说明，点了就调这里。
// 刻意不叫它"密钥/加密"——界面上只说"这台设备还没就绪"。
const listeners = new Set()

export function requestUnlock() {
  for (const cb of listeners) { try { cb() } catch { /* 订阅方自己的错 */ } }
}

export function onUnlockRequested(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
