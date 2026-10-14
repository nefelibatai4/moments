import { supabase } from '../supabaseClient'
import {
  CIRCLE_SCHEME, circleReady, conversationKey, createMomentKey, encryptCircleText,
  encryptForPeer, momentKey,
} from './crypto'

/**
 * 动态/评论的"历史明文补加密"（阶段 2，2026-10-13）。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────
 * 加密只对**新**内容生效；库里已有的动态与评论还是明文。要真正做到"服务器看不到内容"，
 * 就得把这些历史明文也在**使用者的设备上**换成密文（私钥只在这里，服务端做不了）。
 *
 * ── 顺序很重要 ──────────────────────────────────────────────────
 *   ① 先把"我发的、还是明文"的动态补加密：生成 CEK、给每位成员包一份、把正文换成密文。
 *   ② 再处理评论 —— 评论与动态共用 CEK，所以**必须等它所属的动态已经加密**（否则没钥匙可用）。
 *
 * ── 边界 ────────────────────────────────────────────────────────
 *   · 只能补**自己发的**动态/评论（RLS 与 RPC 都这么卡）；对方发的那部分得对方打开时补。
 *   · 动态没有 2 分钟编辑窗口，作者直接 update 即可；评论有窗口，走维护性 RPC。
 *   · 任何一步失败都**不影响内容可读**（顶多还是明文），逐条尽力而为、下次打开接着补。
 */

const MOMENT_BUDGET = 60      // 一次会话最多补这么多条动态（够小到无感，够大到几次就扫完）
const COMMENT_BUDGET = 120
const FAIL_STREAK_MAX = 3

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let running = false

/** 补加密入口：同一页面只跑一条（幂等、可重入；下次打开会接着扫） */
export async function sweepCirclePlaintext(me) {
  if (running || !me) return { moments: 0, comments: 0 }
  running = true
  let moments = 0
  let comments = 0
  try {
    const { ready, members } = await circleReady()
    if (!ready) {
      // 还有成员的公钥世代对不上（没登录过新版本）→ 谁都不加密，保持明文
      return { moments: 0, comments: 0, skipped: 'circle-not-ready' }
    }
    moments = await sweepMoments(me, members)
    comments = await sweepComments(me)
  } catch (err) {
    console.warn('[circle] 补加密中断:', err?.message)
  } finally {
    running = false
    if (moments || comments) console.info(`[circle] 本次补加密 动态 ${moments} · 评论 ${comments}`)
  }
  return { moments, comments }
}

/** ① 我发的、还是明文的动态 → 生成 CEK + 包裹 + 换成密文 */
async function sweepMoments(me, members) {
  let done = 0
  let fails = 0
  while (done < MOMENT_BUDGET && fails < FAIL_STREAK_MAX) {
    const { data, error } = await supabase
      .from('moments')
      .select('id, content')
      .eq('user_id', me)
      .is('ciphertext', null)
      .not('content', 'is', null)
      .order('created_at', { ascending: false })
      .limit(10)
    if (error) { fails += 1; await sleep(800); continue }
    if (!data || data.length === 0) break
    fails = 0
    for (const row of data) {
      if (done >= MOMENT_BUDGET) break
      try {
        const cek = await createMomentKey(row.id, members)
        if (!cek) { fails += 1; continue }
        const sealed = await encryptCircleText(cek, row.content)
        const { data: updated, error: upErr } = await supabase
          .from('moments')
          .update({ ...sealed, content: null })
          .eq('id', row.id)
          .select('id')
        if (upErr || !updated || updated.length === 0) { fails += 1; continue }
        done += 1
      } catch (err) {
        fails += 1
        console.warn('[circle] 动态补加密失败:', err?.message)
      }
    }
    await sleep(120)
  }
  return done
}

/** ② 我发的、还是明文的评论 → 用它所属动态的 CEK 加密（动态必须先加密好） */
async function sweepComments(me) {
  let done = 0
  let fails = 0
  while (done < COMMENT_BUDGET && fails < FAIL_STREAK_MAX) {
    const { data, error } = await supabase
      .from('comments')
      .select('id, moment_id, content, moments!inner(user_id, ciphertext)')
      .eq('user_id', me)
      .is('ciphertext', null)
      .not('content', 'is', null)
      .not('moments.ciphertext', 'is', null)     // 只处理"动态已经加密好"的
      .order('created_at', { ascending: false })
      .limit(20)
    if (error) { fails += 1; await sleep(800); continue }
    if (!data || data.length === 0) break
    fails = 0
    for (const row of data) {
      if (done >= COMMENT_BUDGET) break
      try {
        const cek = await momentKey(row.moment_id, row.moments?.user_id)
        if (!cek) { fails += 1; continue }
        const sealed = await encryptCircleText(cek, row.content)
        if (!sealed || sealed.scheme !== CIRCLE_SCHEME) { fails += 1; continue }
        const { data: ok, error: rpcErr } = await supabase.rpc('encrypt_comment_payload', {
          p_id: row.id, p_ciphertext: sealed.ciphertext, p_iv: sealed.iv, p_scheme: sealed.scheme,
        })
        if (rpcErr) { fails += 1; await sleep(400); continue }
        // ok !== true 通常是"这一条刚被前台补掉了"，属正常竞态，不算失败
        if (ok === true) done += 1
      } catch (err) {
        fails += 1
        console.warn('[circle] 评论补加密失败:', err?.message)
      }
    }
    await sleep(120)
  }
  return done
}

/**
 * 历史**私聊**明文的后台补加密（不要求打开那个会话）。
 *
 * 为什么需要它：会话里的扫尾只有"打开那个会话"时才跑 —— 使用者可能很久都不点进某段对话，
 * 那些历史明文就一直躺在服务器上。改成"打开应用就会补"之后，铺开只依赖他打开过应用。
 *
 * 做法：查**我发的、还是明文的**消息（按时间倒序，一批 50 条）→ 按对方取会话密钥
 * （对方没就绪就跳过）→ 批量写回。每批一次 RPC；预算与别的扫尾一致（一次会话 300 条）。
 */
const MSG_BUDGET = 300
let msgRunning = false

export async function sweepMyMessages(me) {
  if (msgRunning || !me) return 0
  msgRunning = true
  let done = 0
  let fails = 0
  const keyReady = new Map()      // 对方 id → 能不能加密（拿不到会话密钥就别白试）
  try {
    while (done < MSG_BUDGET && fails < 3) {
      const { data, error } = await supabase
        .from('messages')
        .select('id, content, recipient_id')
        .eq('sender_id', me)
        .is('ciphertext', null)
        .is('recalled_at', null)
        .not('content', 'is', null)
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) { fails += 1; await sleep(800); continue }
      if (!data || data.length === 0) break
      fails = 0
      const items = []
      for (const row of data) {
        if (!keyReady.has(row.recipient_id)) {
          keyReady.set(row.recipient_id, !!(await conversationKey(row.recipient_id).catch(() => null)))
        }
        if (!keyReady.get(row.recipient_id)) continue
        try {
          const sealed = await encryptForPeer(row.recipient_id, row.content)
          if (sealed) items.push({ id: row.id, ...sealed })
        } catch { /* 单条失败不影响别人 */ }
      }
      if (items.length === 0) break
      const { data: n, error: rpcErr } = await supabase.rpc('encrypt_message_payloads', { p_items: items })
      if (rpcErr) { fails += 1; await sleep(600); continue }
      done += Number(n) || 0
      await sleep(150)
    }
  } catch (err) {
    console.warn('[chat] 全局补加密中断:', err?.message)
  } finally {
    msgRunning = false
    if (done) console.info(`[chat] 本次补加密历史私聊 ${done} 条`)
  }
  return done
}
