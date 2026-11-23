/**
 * 「Ace 现在是什么状态」——只从**已经解密的消息**里推，不额外查库。
 *
 * 为什么要有这个文件：群里三个状态（在线 / 在忙 / 不在线）原本只有前两个能看出来，
 * 而"在忙"这件事桥其实一直在写（`ai_state: working` 那条消息会被进度播报原地改写），
 * 所以只要看**Ace 最后那条消息**是什么就能判断，不需要新的表、新的通道：
 *
 *   · 最后一条是 `ai_state: working`，且最近 `ttl` 内还在更新（body.at）→ **在忙**
 *   · 最后一条是 `ai_state: working`，但很久没更新（桥挂了/进程被杀）→ 状态未知
 *   · 最后一条是普通文字/状态（thinking/waiting）→ 不忙（在线由 presence 心跳决定）
 *
 * ⚠️ 进度是**原地改写**同一条消息（created_at 不变），所以"新不新"必须看 body.at，
 *    不能看 created_at（那是开始动手的时间，20 分钟后早过期了）。
 */

export const BUSY_TTL_MS = 3 * 60 * 1000

/**
 * @param {{sender_id:string, body?:object}[]} messages 按时间升序的群消息（已解密）
 * @param {{aceId:string, now?:number, ttl?:number}} opts
 * @returns {{busy:boolean, stale:boolean, minutes:number, step:number, text:string}}
 */
export function aceWorkStatus(messages, { aceId, now = Date.now(), ttl = BUSY_TTL_MS } = {}) {
  const empty = { busy: false, stale: false, minutes: 0, step: 0, text: '' }
  if (!aceId) return empty
  // 只看 Ace 自己发的、且"能说明它在不在干活"的那一类（ai_state / text）
  let last = null
  for (const m of messages ?? []) {
    if (m?.sender_id !== aceId) continue
    const kind = m.body?.kind
    if (kind === 'ai_state' || kind === 'text') last = m
  }
  if (!last || last.body?.kind !== 'ai_state' || last.body?.state !== 'working') return empty

  const at = Number(last.body?.at) || 0
  // 没有时间戳的 working 行（老数据、或"聊天时用了一次工具"那种）**不能**当成"在忙/失联"：
  // 否则头部会一直显示"状态未知"（2026-11-23 真实反馈：一直卡在那个状态）。
  // 只有"确实是干活、且给了进度时间戳"的行才判在忙/失联。
  if (!at) return empty
  const since = Number(last.body?.since) || at
  const minutes = since ? Math.max(0, Math.round((now - since) / 60000)) : 0
  const fresh = now - at < ttl
  return {
    busy: fresh,
    stale: !fresh,
    minutes,
    step: Number(last.body?.step) || 0,
    text: String(last.body?.text ?? ''),
  }
}
