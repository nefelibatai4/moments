import { supabase } from '../supabaseClient'
import { groupKey, openGroupText, sealGroupText } from './crypto'

/**
 * 群聊数据层（私密圈后花园）。
 *
 * 一张表一件事：
 *  - `group_threads`  群本身（名字、谁建的）
 *  - `group_members`  谁在这个群里
 *  - `group_keys`     群密钥"一人一份"的包裹（RLS：只能读自己那份）
 *  - `group_messages` 消息行；正文永远在 `ciphertext` 里
 *
 * 消息正文是一个 JSON 信封（加密之后才落库，服务端看不到 kind）：
 *  - 人写的：`{"v":1,"kind":"text","text":"..."}`
 *  - AI 状态：`{"v":1,"kind":"ai_state","state":"thinking"|"working"|"waiting"|"offline"}`
 *  - AI 回复：`{"v":1,"kind":"text","text":"...","by":"ai"}`
 * 同一条 AI 行会从"状态"长成"回复"（bridge 就地 UPDATE），所以气泡不会多出来一个。
 */

const SEEN_PREFIX = 'moments_group_seen_v1'

/** 群列表（RLS 只返回我是成员的群），带成员清单 */
export async function listGroupThreads() {
  const { data, error } = await supabase
    .from('group_threads')
    .select('id, name, created_by, created_at')
    .order('created_at', { ascending: true })
  if (error) return { threads: [], error: error.message }
  const threads = data ?? []
  if (threads.length === 0) return { threads: [], error: null }
  const { data: memberRows, error: mErr } = await supabase
    .from('group_members')
    .select('thread_id, user_id, joined_at')
    .in('thread_id', threads.map((t) => t.id))
  if (mErr) return { threads: threads.map((t) => ({ ...t, members: [] })), error: mErr.message }
  const ids = [...new Set((memberRows ?? []).map((m) => m.user_id))]
  const { data: profiles } = ids.length
    ? await supabase.from('profiles').select('id, nickname, avatar_url, is_ai').in('id', ids)
    : { data: [] }
  const byId = new Map((profiles ?? []).map((p) => [p.id, p]))
  const out = threads.map((t) => {
    const members = (memberRows ?? [])
      .filter((m) => m.thread_id === t.id)
      .map((m) => ({
        id: m.user_id,
        nickname: byId.get(m.user_id)?.nickname ?? '成员',
        avatar_url: byId.get(m.user_id)?.avatar_url ?? null,
        is_ai: !!byId.get(m.user_id)?.is_ai,
      }))
    return { ...t, members, memberCount: members.length }
  })
  return { threads: out, error: null }
}

/** 取某个群的群密钥（缓存解包裹；拿不到返回 null —— 调用方显示"钥匙不在本机"而不是瞎猜） */
export async function groupKeyFor(thread) {
  if (!thread?.id) return null
  // wrapped_by 由 group_keys 行自己说了算（见 crypto.js groupKey 的说明）
  return groupKey(thread.id, thread.created_by ?? null)
}

/** 解一条群消息 → {kind, text, state, by}；解不开返回 {kind:'locked'} */
export function decodeGroupBody(row, plain) {
  if (plain == null) return { kind: 'locked' }
  try {
    const parsed = JSON.parse(plain)
    if (parsed && parsed.v === 1 && typeof parsed.kind === 'string') {
      return { kind: parsed.kind, text: parsed.text ?? '', state: parsed.state, by: parsed.by }
    }
  } catch { /* 普通文本 */ }
  return { kind: 'text', text: String(plain) }
}

/** 读一屏消息并解密（新的在后）。解不开的行保留 kind:'locked'，绝不把密文当正文显示。 */
export async function loadGroupMessages(thread, { limit = 300 } = {}) {
  const key = await groupKeyFor(thread)
  const { data, error } = await supabase
    .from('group_messages')
    .select('id, thread_id, sender_id, ciphertext, iv, scheme, content, reply_to_id, recalled_at, created_at')
    .eq('thread_id', thread.id)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) return { messages: [], error: error.message, key }
  const messages = []
  for (const row of data ?? []) {
    const plain = row.recalled_at ? null : await openGroupText(key, row)
    messages.push({ ...row, body: row.recalled_at ? { kind: 'recalled' } : decodeGroupBody(row, plain) })
  }
  return { messages, error: null, key }
}

/** 只解密一行（实时收到 INSERT/UPDATE 时用） */
export async function decryptGroupRow(key, row) {
  if (!row) return null
  const plain = row.recalled_at ? null : await openGroupText(key, row)
  return { ...row, body: row.recalled_at ? { kind: 'recalled' } : decodeGroupBody(row, plain) }
}

/** 发一条消息：加密失败就**不发**（返回错误，让界面说清楚），不发明文 */
export async function sendGroupMessage(threadId, key, body, replyToId = null, senderId = null) {
  if (!key) return { error: '钥匙不在本机' }
  const sealed = await sealGroupText(key, JSON.stringify({ v: 1, ...body }))
  if (!sealed) return { error: '加密失败' }
  // sender_id 由 RLS 检查必须等于 auth.uid()；数据库默认值不适用，这里显式写
  const sender = senderId ?? (await supabase.auth.getUser()).data?.user?.id
  if (!sender) return { error: '还没登录' }
  const { data, error } = await supabase
    .from('group_messages')
    .insert({
      thread_id: threadId,
      sender_id: sender,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      scheme: sealed.scheme,
      reply_to_id: replyToId,
    })
    .select('id, thread_id, sender_id, ciphertext, iv, scheme, reply_to_id, recalled_at, created_at')
    .single()
  if (error) return { error: error.message }
  return { row: { ...data, body: { kind: 'text', text: body.text ?? '' } } }
}

/** 撤回自己的消息（RPC 无需：直接 UPDATE 自己那行） */
export async function recallGroupMessage(id) {
  const { error } = await supabase
    .from('group_messages')
    .update({ recalled_at: new Date().toISOString() })
    .eq('id', id)
  return { error: error?.message ?? null }
}

/**
 * 实时订阅这个群的新消息与更新。
 * @returns {() => void} 取消订阅
 */
export function subscribeGroupMessages(threadId, onEvent) {
  const channel = supabase
    .channel(`group:${threadId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'group_messages',
      filter: `thread_id=eq.${threadId}`,
    }, (payload) => onEvent('insert', payload.new))
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'group_messages',
      filter: `thread_id=eq.${threadId}`,
    }, (payload) => onEvent('update', payload.new))
    .subscribe()
  return () => { supabase.removeChannel(channel) }
}

// ── 已读标记（本机记录；群里就两个人 + 一个 AI，不做已读回执）─────────
function seenKey(uid, threadId) { return `${SEEN_PREFIX}:${uid}:${threadId}` }

export function readGroupSeen(uid, threadId) {
  try { return localStorage.getItem(seenKey(uid, threadId)) ?? null } catch { return null }
}

export function markGroupSeen(uid, threadId, iso) {
  try { localStorage.setItem(seenKey(uid, threadId), iso ?? new Date().toISOString()) } catch { /* 隐私模式 */ }
}

/** 未读数：比"上次看到的时间"新的、别人发的、非 AI 状态行（状态气泡不算消息） */
export function countUnread(messages, uid, seenAt) {
  if (!seenAt) return 0
  const since = new Date(seenAt).getTime()
  return messages.filter((m) => (
    m.sender_id !== uid
    && new Date(m.created_at).getTime() > since
    && m.body?.kind !== 'ai_state'
  )).length
}

/** 群成员里最"像人"的显示：Ace 标出来 */
export function displayName(member) {
  if (!member) return '成员'
  return member.is_ai ? `${member.nickname}` : member.nickname
}

// ── 在线心跳（目前只有 Ace 用：它每 30 秒写一次 last_seen_at）─────────
/** 心跳超过这个时长就算"不在线"（Ace 每 30 秒写一次，留三倍余量） */
export const PRESENCE_STALE_MS = 90 * 1000

export async function loadGroupPresence(threadId) {
  const { data, error } = await supabase
    .from('group_presence')
    .select('user_id, last_seen_at')
    .eq('thread_id', threadId)
  if (error) return {}
  const out = {}
  for (const row of data ?? []) out[row.user_id] = row.last_seen_at
  return out
}

/** 心跳是否新鲜（只用来判断 Ace 在不在，不做"已读"用） */
export function isPresenceFresh(iso, now = Date.now()) {
  if (!iso) return false
  return now - new Date(iso).getTime() < PRESENCE_STALE_MS
}

/**
 * 给聊天列表用的群摘要：最后一条（状态气泡不算）+ 未读数。
 * 只取每个群最近 40 条，避免为了一个角标把整段历史拉下来（流量按条计）。
 */
const SNAPSHOT_PREFIX = 'moments_group_list_v1'

/** 上次加载到的群摘要（本机快照）：聊天列表要**第一帧就有群入口**，不能等解密 */
export function readGroupSnapshot(uid) {
  try {
    const raw = localStorage.getItem(`${SNAPSHOT_PREFIX}:${uid}`)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function writeGroupSnapshot(uid, summaries) {
  try {
    // 只存列表要用的字段（别把整段消息塞进 localStorage）
    const slim = summaries.map((s) => ({
      thread: { id: s.thread.id, name: s.thread.name, created_by: s.thread.created_by, memberCount: s.thread.memberCount },
      latest: s.latest ? { body: s.latest.body, created_at: s.latest.created_at, sender_id: s.latest.sender_id } : null,
      unread: s.unread,
      lastTime: s.lastTime,
    }))
    localStorage.setItem(`${SNAPSHOT_PREFIX}:${uid}`, JSON.stringify({ at: Date.now(), summaries: slim }))
  } catch { /* 隐私模式 */ }
}

export async function loadGroupSummaries(uid) {
  const { threads, error } = await listGroupThreads()
  if (error) return { summaries: [], error }

  // 解密并行做：40 条串行 await 会让"群入口出现"晚 1–2 秒（2026-11-19 使用者反馈）
  const out = await Promise.all(threads.map(async (t) => {
    const key = await groupKeyFor(t)
    const { data } = await supabase
      .from('group_messages')
      .select('id, thread_id, sender_id, ciphertext, iv, scheme, content, reply_to_id, recalled_at, created_at')
      .eq('thread_id', t.id)
      .order('created_at', { ascending: false })
      .limit(40)
    const rows = await Promise.all((data ?? []).map(async (row) => {
      const plain = row.recalled_at ? null : await openGroupText(key, row)
      return { ...row, body: row.recalled_at ? { kind: 'recalled' } : decodeGroupBody(row, plain) }
    }))
    const latest = rows.find((r) => r.body.kind !== 'ai_state') ?? null
    const seenAt = readGroupSeen(uid, t.id)
    return {
      thread: t,
      latest,
      unread: countUnread(rows, uid, seenAt),
      lastTime: latest?.created_at ?? rows[0]?.created_at ?? t.created_at,
    }
  }))
  writeGroupSnapshot(uid, out)
  return { summaries: out, error: null }
}
