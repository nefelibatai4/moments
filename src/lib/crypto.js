import { supabase } from '../supabaseClient'
import { decryptImageBytes, encryptImageBytes, fetchAndDecryptImage, looksLikeImage } from './imageCrypto'

/**
 * 无感加密 · 阶段 0：密钥基础设施（2026-10-12 使用者定稿）
 *
 * ── 目标（使用者原话）────────────────────────────────────────────
 * "数据加密是刚需，但必须**用户无感**"。上一版要用户抄恢复码，已经证明不可用。
 * 这一版的唯一交互就是**登录输密码**（他本来就要做的事）。
 *
 * ── 怎么做到无感 ────────────────────────────────────────────────
 *   密码（客户端派生）─┬─→ **登录凭据**：发给 Supabase 的是它 → 服务器永远看不到真实密码
 *                     └─→ **KEK**：用来包住密钥，永不出设备
 *   数据用随机 **DEK** 加密；DEK 与身份私钥都被 KEK 包住存在服务器上（服务器解不开）。
 *   换密码 = 用旧密码解开、用新密码重包 → 历史照旧，用户无感。
 *   新设备 = 登录输密码 → 自动解开 → 零额外操作、界面上**没有任何密钥字样**。
 *
 * ── 社交恢复（阶段 0b）──────────────────────────────────────────
 *   每个成员还会替别人存一份"DEK 的包裹"（用 owner 私钥 × holder 公钥包），
 *   谁忘了密码找对方取一次即可。表已建好（`key_escrow`），逻辑下一轮接。
 *
 * ⚠️ 安全边界（不变）：服务器/我/云厂商都看不到内容；但**密码本身就等于钥匙**，
 *    弱密码 = 弱保护（所以 KEK 用 60 万次 PBKDF2 拖时间）。另外：帮人恢复的那位，
 *    理论上能读被恢复者的数据（社交恢复的固有代价，已告知使用者）。
 */

const KEK_ITERATIONS = 600000
const AUTH_INFO = 'moments-auth-v1'      // 派生登录凭据
const KEK_INFO = 'moments-kek-v1'        // 派生包裹密钥
const IDENTITY_ALGO = { name: 'ECDH', namedCurve: 'P-256' }

const te = new TextEncoder()
const td = new TextDecoder()

// ── 内存里的"已解锁"状态（刷新即失效，磁盘上不留明文密钥）────────
let currentDek = null          // CryptoKey（AES-GCM 256）
let currentIdentity = null     // { privateKey: CryptoKey, publicJwk }
let currentUserId = null

// "解锁状态变了"的订阅：界面靠它重算（比如登录前先渲染、解锁后补解密的私聊）。
// 不加这个就会卡在"密钥还没进内存 → 解不出来 → 界面永远停在读不到"（实测踩到过）。
let unlockVersion = 0
const unlockListeners = new Set()
function bumpUnlock() {
  unlockVersion += 1
  for (const cb of unlockListeners) {
    try { cb(unlockVersion) } catch { /* 订阅方自己的错，不影响别人 */ }
  }
}
/** 订阅解锁状态变化，返回退订函数 */
export function onUnlockChange(cb) {
  unlockListeners.add(cb)
  return () => unlockListeners.delete(cb)
}
export function unlockStateVersion() {
  return unlockVersion
}

export function isUnlocked() {
  return !!currentDek && currentUserId != null
}
export function lockedUserId() {
  return currentUserId
}
export function lockCrypto() {
  currentDek = null
  currentIdentity = null
  currentUserId = null
  conversationKeys.clear()
  noPeerKeyUntil.clear()
  pubCache.clear()
  momentKeys.clear()
  bumpUnlock()
}
export function unlockedDek() {
  return currentDek
}
export function unlockedIdentity() {
  return currentIdentity
}

// ── base64 小工具 ───────────────────────────────────────────────
function toB64(buf) {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
function fromB64(s) {
  const raw = atob(s)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

/** 邮箱统一小写：派生结果必须跨设备一致 */
function normEmail(email) {
  return String(email || '').trim().toLowerCase()
}

/**
 * 登录凭据：发给 Supabase 的"密码"。
 * 这样服务器永远拿不到真实密码，也就无法派生出 KEK。
 */
export async function deriveAuthPassword(password, email) {
  const base = await crypto.subtle.importKey('raw', te.encode(String(password)), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: te.encode('moments-login-salt-v1'),
      info: te.encode(`${AUTH_INFO}:${normEmail(email)}`),
    },
    base,
    256,
  )
  // 用 base64url，避免任何字符集/传输问题；长度 43 位足够
  return toB64(bits).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** KEK：包住 DEK 与身份私钥的密钥（永不出设备） */
async function deriveKek(password, email, saltB64, iterations = KEK_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', te.encode(String(password)), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: fromB64(saltB64),
      iterations,
      hash: 'SHA-256',
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

async function generateIdentityJwks() {
  const pair = await crypto.subtle.generateKey(IDENTITY_ALGO, true, ['deriveBits'])
  const [publicKey, privateKey] = await Promise.all([
    crypto.subtle.exportKey('jwk', pair.publicKey),
    crypto.subtle.exportKey('jwk', pair.privateKey),
  ])
  return { publicKey, privateKey }
}

/**
 * 首次登录（或服务器上还没有密钥行）时，生成 DEK + 身份密钥，并用 KEK 包好上传。
 * @returns {Promise<{dek: CryptoKey, identity: {privateKey: CryptoKey, publicJwk: object}}>}
 */
async function createAndUploadKeys(userId, password, email) {
  const kekSalt = toB64(crypto.getRandomValues(new Uint8Array(16)))
  const kek = await deriveKek(password, email, kekSalt)

  // DEK
  const rawDek = crypto.getRandomValues(new Uint8Array(32))
  const dekKey = await crypto.subtle.importKey('raw', rawDek, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'])
  const dekIv = crypto.getRandomValues(new Uint8Array(12))
  const dekWrapped = await crypto.subtle.wrapKey('raw', dekKey, kek, { name: 'AES-GCM', iv: dekIv })

  // 身份密钥对（社交恢复用）
  const jwks = await generateIdentityJwks()
  const idKey = await crypto.subtle.importKey('jwk', jwks.privateKey, IDENTITY_ALGO, true, ['deriveBits'])
  const idIv = crypto.getRandomValues(new Uint8Array(12))
  const idWrapped = await crypto.subtle.wrapKey('jwk', idKey, kek, { name: 'AES-GCM', iv: idIv })

  const row = {
    user_id: userId,
    kek_salt: kekSalt,
    kek_iterations: KEK_ITERATIONS,
    dek_iv: toB64(dekIv),
    dek_wrapped: toB64(dekWrapped),
    identity_iv: toB64(idIv),
    identity_wrapped: toB64(idWrapped),
    identity_public: jwks.publicKey,
    updated_at: new Date().toISOString(),
  }
  const { error } = await supabase.from('user_keys').upsert(row, { onConflict: 'user_id' })
  if (error) throw new Error(error.message)

  // 顺便把公钥 + **世代标记**放到 profiles：别人只有看到世代对得上，才敢给你加密
  await supabase.from('profiles').update({ public_key: jwks.publicKey, key_scheme: KEY_SCHEME }).eq('id', userId)

  // 可导出：设备缓存与"换密码重包"都要用它（只在内存里，不落盘明文）
  const identityPriv = await crypto.subtle.importKey('jwk', jwks.privateKey, IDENTITY_ALGO, true, ['deriveBits'])
  return { dek: dekKey, identity: { privateKey: identityPriv, publicJwk: jwks.publicKey } }
}

/**
 * 登录后用密码解锁（零额外操作）：
 *   · 服务器上已有密钥行 → 用密码解开 DEK 与身份私钥
 *   · 还没有（第一次）→ 生成并上传
 * @returns {Promise<{ok: boolean, created?: boolean, reason?: string}>}
 */
export async function unlockWithPassword(userId, password, email) {
  if (!userId || !password) return { ok: false, reason: '缺少参数' }
  if (typeof crypto === 'undefined' || !crypto.subtle) return { ok: false, reason: '这个浏览器不支持加密' }

  const { data, error } = await supabase
    .from('user_keys')
    .select('kek_salt, kek_iterations, dek_iv, dek_wrapped, identity_iv, identity_wrapped, identity_public')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return { ok: false, reason: error.message }

  if (!data) {
    try {
      const created = await createAndUploadKeys(userId, password, email)
      currentDek = created.dek
      currentIdentity = created.identity
      currentUserId = userId
      bumpUnlock()
      return { ok: true, created: true }
    } catch (err) {
      return { ok: false, reason: err?.message }
    }
  }

  const kek = await deriveKek(password, email, data.kek_salt, data.kek_iterations)
  let dekKey
  try {
    dekKey = await crypto.subtle.unwrapKey(
      'raw', fromB64(data.dek_wrapped), kek,
      { name: 'AES-GCM', iv: fromB64(data.dek_iv) },
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
    )
  } catch {
    return { ok: false, reason: '密码对不上（换过密码？）' }
  }
  // ⚠️ 身份私钥单独 try：它与 DEK 用的是同一把 KEK，但**换密码时如果只重包了 DEK、
  //    漏了身份私钥**，症状就会是"数据能读、但这段报错"——分开报出来才查得动（实测踩到过）。
  let identityPriv = null
  try {
    identityPriv = await crypto.subtle.unwrapKey(
      'jwk', fromB64(data.identity_wrapped), kek,
      { name: 'AES-GCM', iv: fromB64(data.identity_iv) },
      IDENTITY_ALGO, true, ['deriveBits'],   // 可导出：换密码时要在内存里重包（不会落盘）
    )
  } catch {
    console.warn('[crypto] 身份私钥解不开（换密码时可能漏了重包）')
  }
  currentDek = dekKey
  currentIdentity = identityPriv ? { privateKey: identityPriv, publicJwk: data.identity_public } : null
  currentUserId = userId
  bumpUnlock()
  return { ok: true }
}

/**
 * 换密码：只重包（DEK 与身份私钥本身不变）→ 历史照旧可读，用户无感。
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function rekeyForNewPassword(userId, oldPassword, newPassword, email) {
  const { data, error } = await supabase
    .from('user_keys')
    .select('kek_salt, kek_iterations, dek_iv, dek_wrapped, identity_iv, identity_wrapped, identity_public')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return { ok: false, reason: error.message }
  if (!data) return { ok: false, reason: '服务器上没有密钥行' }

  const oldKek = await deriveKek(oldPassword, email, data.kek_salt, data.kek_iterations)
  let dekKey
  let identityJwk
  try {
    dekKey = await crypto.subtle.unwrapKey(
      'raw', fromB64(data.dek_wrapped), oldKek,
      { name: 'AES-GCM', iv: fromB64(data.dek_iv) },
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
    )
    const idKey = await crypto.subtle.unwrapKey(
      'jwk', fromB64(data.identity_wrapped), oldKek,
      { name: 'AES-GCM', iv: fromB64(data.identity_iv) },
      IDENTITY_ALGO, true, ['deriveBits'],
    )
    identityJwk = await crypto.subtle.exportKey('jwk', idKey)
  } catch {
    return { ok: false, reason: '旧密码对不上' }
  }

  // 用新密码重包
  const newSalt = toB64(crypto.getRandomValues(new Uint8Array(16)))
  const newKek = await deriveKek(newPassword, email, newSalt)
  const dekIv = crypto.getRandomValues(new Uint8Array(12))
  const dekWrapped = await crypto.subtle.wrapKey('raw', dekKey, newKek, { name: 'AES-GCM', iv: dekIv })
  const idKeyForWrap = await crypto.subtle.importKey('jwk', identityJwk, IDENTITY_ALGO, true, ['deriveBits'])
  const idIv = crypto.getRandomValues(new Uint8Array(12))
  const idWrapped = await crypto.subtle.wrapKey('jwk', idKeyForWrap, newKek, { name: 'AES-GCM', iv: idIv })

  const { error: upErr } = await supabase.from('user_keys').update({
    kek_salt: newSalt,
    kek_iterations: KEK_ITERATIONS,
    dek_iv: toB64(dekIv),
    dek_wrapped: toB64(dekWrapped),
    identity_iv: toB64(idIv),
    identity_wrapped: toB64(idWrapped),
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId)
  if (upErr) return { ok: false, reason: upErr.message }

  currentDek = dekKey
  currentUserId = userId
  return { ok: true }
}

// ── 数据加解密（阶段 1 起会被私聊/动态/图片用到）─────────────────
export async function encryptJson(value) {
  if (!currentDek) throw new Error('还没有解锁（请先登录）')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, currentDek, te.encode(JSON.stringify(value)))
  return { iv: toB64(iv), ciphertext: toB64(ct) }
}

export async function decryptJson(ciphertextB64, ivB64) {
  if (!currentDek) throw new Error('还没有解锁（请先登录）')
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(ivB64) },
    currentDek,
    fromB64(ciphertextB64),
  )
  return JSON.parse(td.decode(plain))
}

export async function encryptText(value) {
  if (!currentDek) throw new Error('还没有解锁（请先登录）')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, currentDek, te.encode(String(value)))
  return { iv: toB64(iv), ciphertext: toB64(ct) }
}

export async function decryptText(ciphertextB64, ivB64) {
  if (!currentDek) throw new Error('还没有解锁（请先登录）')
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(ivB64) },
    currentDek,
    fromB64(ciphertextB64),
  )
  return td.decode(plain)
}

// ── 会话密钥（阶段 1：私聊文本）─────────────────────────────────
/**
 * 一对一会话的密钥由**双方各自的身份私钥 × 对方公钥**做 ECDH 得到：
 *   CK(A,B) = HKDF( ECDH(A_priv, B_pub) ) == HKDF( ECDH(B_priv, A_pub) )
 * 好处是**不需要分发密钥**：谁都不用把钥匙交给谁，服务器上也没有任何能解开消息的东西。
 *
 * ⚠️ 已知边界（诚实记录）：双方公钥是从 `profiles` 里取的，等于**信任服务器分发公钥**。
 *    服务器若掉包公钥就能中间人。彻底解决要人工核对指纹，那就不"无感"了 —— 取舍已告知使用者。
 */
const DM_INFO = 'moments-dm-v1'
/** 密文行里的算法标记：换算法时老消息仍能按老标记解 */
export const DM_SCHEME = 'v2-dm'
/**
 * 公钥"世代"标记：只有**由这一代代码上传过密钥**的人，`profiles.key_scheme` 才是这个值。
 * 为什么需要：真实数据里躺着上一版加密（2026-10-12 已下线）留下的公钥，对方的私钥早没了——
 * 照旧加密就会产出**永远解不开**的消息。所以"公钥存在"还不够，必须**世代对得上**才加密；
 * 对不上就退回明文（宁可暂时不加密，也不制造读不回来的历史）。
 */
export const KEY_SCHEME = 'v2'
const conversationKeys = new Map()   // "小id|大id" → CryptoKey
const noPeerKeyUntil = new Map()     // 用户 id → 时间戳：这个人还没有可用公钥（短时负缓存）
const pubCache = new Map()           // 用户 id → { jwk, at }：公钥读取缓存（私聊/动态都要用）

function pairTag(a, b) {
  return [String(a), String(b)].sort().join('|')
}

/**
 * 取某个人的**可用公钥**（"有公钥"且"世代对得上"才算可用）。
 * 私聊与动态都走这里，所以缓存放在一层：5 分钟正缓存 + 30 秒负缓存。
 * ⚠️ 公钥是从服务器读的 → 等于信任服务器分发公钥（已知边界，见上）。
 */
async function peerKeyInfo(peerId) {
  const hit = pubCache.get(peerId)
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.jwk
  if ((noPeerKeyUntil.get(peerId) ?? 0) > Date.now()) return null
  const { data, error } = await supabase
    .from('profiles')
    .select('public_key, key_scheme')
    .eq('id', peerId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data?.public_key || data.key_scheme !== KEY_SCHEME) {
    noPeerKeyUntil.set(peerId, Date.now() + 30000)
    return null
  }
  pubCache.set(peerId, { jwk: data.public_key, at: Date.now() })
  noPeerKeyUntil.delete(peerId)
  return data.public_key
}

/** 会话密钥的原始 ECDH 位（测试要对指纹用；业务代码用下面的 conversationKey） */
async function pairBits(peerId) {
  if (!currentUserId || !currentIdentity?.privateKey) return null
  if (!peerId || peerId === currentUserId) return null
  const jwk = await peerKeyInfo(peerId)
  if (!jwk) return null
  const pub = await crypto.subtle.importKey('jwk', jwk, IDENTITY_ALGO, false, [])
  return crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, currentIdentity.privateKey, 256)
}

async function deriveConversationKey(peerId) {
  const bits = await pairBits(peerId)
  if (!bits) return null
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: te.encode(`moments-pair-v1:${pairTag(currentUserId, peerId)}`),
      info: te.encode(DM_INFO),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** 取会话密钥（内存缓存；拿不到返回 null：对方还没公钥 / 本机还没解锁） */
export async function conversationKey(peerId) {
  const tag = pairTag(currentUserId, peerId)
  if (conversationKeys.has(tag)) return conversationKeys.get(tag)
  const ck = await deriveConversationKey(peerId)
  if (ck) conversationKeys.set(tag, ck)
  return ck
}

/** 测试/排障：会话密钥指纹（证明两台设备派生出同一把钥匙，且不泄露钥匙本身） */
export async function conversationFingerprint(peerId) {
  const bits = await pairBits(peerId)
  if (!bits) return null
  const digest = await crypto.subtle.digest('SHA-256', bits)
  return toB64(digest).slice(0, 12)
}

/**
 * 加密一条私聊文本。**拿不到密钥就返回 null**，由调用方决定怎么办
 * （本轮的做法：照旧发明文 + 控制台留一行 —— 宁可漏加密，也不让使用者发不出消息）。
 */
export async function encryptForPeer(peerId, text) {
  const ck = await conversationKey(peerId)
  if (!ck) return null
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ck, te.encode(String(text)))
  return { ciphertext: toB64(ct), iv: toB64(iv), scheme: DM_SCHEME }
}

/** 解一条私聊行：密文行解不开返回 null；明文老行原样返回 content */
export async function decryptForPeer(peerId, row) {
  if (!row) return null
  if (!row.ciphertext) return row.content ?? null
  const ck = await conversationKey(peerId)
  if (!ck) return null
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(row.iv) },
      ck,
      fromB64(row.ciphertext),
    )
    return td.decode(plain)
  } catch {
    return null
  }
}

/** 批量解一屏私聊行（密钥只取一次；返回的新数组把 content 填成明文） */
export async function decryptPeerMessages(peerId, rows) {
  const ck = await conversationKey(peerId)
  if (!ck) return rows
  const out = []
  for (const row of rows) {
    if (!row.ciphertext) { out.push(row); continue }
    let content = row.content ?? null
    try {
      content = td.decode(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(row.iv) }, ck, fromB64(row.ciphertext),
      ))
    } catch { /* 解不开就沿用行里已有的（本地缓存里的明文） */ }
    out.push({ ...row, content })
  }
  return out
}

/** 登出时清掉内存里的会话密钥（换账号不能残留） */
export function clearConversationKeys() {
  conversationKeys.clear()
  noPeerKeyUntil.clear()
  pubCache.clear()
  momentKeys.clear()
}

// ── 圈子内容密钥（阶段 2：动态与评论文字）─────────────────────────
/**
 * 每条动态一把随机 **CEK**，用 `ECDH(发布者私钥, 成员公钥)` 派生的包裹密钥包成"一人一份"，
 * 存在 `moment_keys`（RLS：每人只能读到自己那一份）。评论与动态共用这条 CEK。
 *
 * 为什么不做"一把圈子主密钥"：那样成员一变动就得换钥、还得重新加密历史；
 * 现在换成员只是"以后的新动态多包一份"，历史照旧。
 * 代价（诚实记录）：**新成员看不到他加入之前的动态**（那些 CEK 从没给他包过）。
 */
const WRAP_INFO = 'moments-cek-v1'
/** 密文行里的算法标记（动态/评论共用） */
export const CIRCLE_SCHEME = 'v2-circle'
const momentKeys = new Map()         // momentId → CryptoKey

/** 成员清单 + "能不能加密"：**所有已激活成员的公钥世代都得对得上**，否则不加密。
 *  理由：圈子是"所有人都能看"，任何一个成员解不开 = 这个人看不到内容，宁可先明文。 */
export async function circleReady() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, public_key, key_scheme')
    .eq('approved', true)
  if (error) return { ready: false, members: [] }
  const members = data ?? []
  const ready = members.length > 0 && members.every((m) => !!m.public_key && m.key_scheme === KEY_SCHEME)
  return { ready, members }
}

/** 包裹密钥：只有"发布者私钥 × 这一位成员公钥"这一对算得出来（双方算出的相同） */
async function deriveWrapKek(otherId, otherJwk, usages) {
  const pub = await crypto.subtle.importKey('jwk', otherJwk, IDENTITY_ALGO, false, [])
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, currentIdentity.privateKey, 256)
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // 盐里带上"发布者|读者"两人 id（排序后），保证包与解用的是同一个派生上下文
      salt: te.encode(`moments-wrap-v1:${pairTag(currentUserId, otherId)}`),
      info: te.encode(WRAP_INFO),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  )
}

/**
 * 给一条动态生成 CEK 并给每位成员各包一份（发布者自己那份用"自己的公钥"包，
 * ECDH(私钥, 自己公钥) 只有自己算得出来，所以新设备登录后照样能读）。
 * @returns {Promise<CryptoKey|null>} 生成好的 CEK（失败返回 null，调用方应退回明文）
 */
export async function createMomentKey(momentId, members) {
  if (!momentId || !currentIdentity?.privateKey || !currentUserId) return null
  const list = (members ?? []).filter((m) => m?.id && m?.public_key)
  if (list.length === 0) return null
  // ⚠️ **幂等**：这条动态已经有包裹了，就绝不能再造一把新 CEK（新的会覆盖旧包裹，
  //    用它加密过的正文/图片就永远解不开了）。改成取回现有那把。
  //    真实触发路径：重复点发布、前台补加密与后台扫尾同时跑到同一条。
  const { data: existing } = await supabase
    .from('moment_keys')
    .select('iv')
    .eq('moment_id', momentId)
    .limit(1)
  if (existing && existing.length > 0) return momentKey(momentId, currentUserId)
  const cek = await crypto.subtle.importKey(
    'raw', crypto.getRandomValues(new Uint8Array(32)),
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
  )
  try {
    const rows = []
    for (const m of list) {
      const kek = await deriveWrapKek(m.id, m.public_key, ['wrapKey'])
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const wrapped = await crypto.subtle.wrapKey('raw', cek, kek, { name: 'AES-GCM', iv })
      rows.push({ moment_id: momentId, user_id: m.id, iv: toB64(iv), wrapped: toB64(wrapped), scheme: CIRCLE_SCHEME })
    }
    const { error } = await supabase.from('moment_keys').upsert(rows, { onConflict: 'moment_id,user_id' })
    if (error) {
      console.warn('[circle] 写钥匙包裹失败:', error.message)
      return null
    }
    momentKeys.set(momentId, cek)
    return cek
  } catch (err) {
    console.warn('[circle] 生成钥匙包裹失败:', err?.message)
    return null
  }
}

/** 取某条动态的 CEK：解开"自己那一份"包裹（内存缓存；拿不到返回 null） */
export async function momentKey(momentId, authorId) {
  if (!momentId || !authorId) return null
  if (momentKeys.has(momentId)) return momentKeys.get(momentId)
  if (!currentIdentity?.privateKey || !currentUserId) return null
  const { data, error } = await supabase
    .from('moment_keys')
    .select('iv, wrapped')
    .eq('moment_id', momentId)
    .eq('user_id', currentUserId)
    .maybeSingle()
  if (error || !data) return null
  const authorJwk = await peerKeyInfo(authorId)
  if (!authorJwk) return null
  try {
    const kek = await deriveWrapKek(authorId, authorJwk, ['unwrapKey'])
    const cek = await crypto.subtle.unwrapKey(
      'raw', fromB64(data.wrapped), kek,
      { name: 'AES-GCM', iv: fromB64(data.iv) },
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
    )
    momentKeys.set(momentId, cek)
    return cek
  } catch {
    return null
  }
}

/** 用 CEK 加密一段文字（动态或评论） */
export async function encryptCircleText(cek, text) {
  if (!cek) return null
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cek, te.encode(String(text)))
  return { ciphertext: toB64(ct), iv: toB64(iv), scheme: CIRCLE_SCHEME }
}

/** 用 CEK 解一段文字：解不开就沿用行里已有的（本地快照里的明文），都没有才返回 null */
export async function decryptCircleText(cek, row) {
  if (!cek || !row?.ciphertext) return row?.content ?? null
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(row.iv) }, cek, fromB64(row.ciphertext),
    )
    return td.decode(plain)
  } catch {
    return row.content ?? null
  }
}

/**
 * 时间线一屏数据的解密：动态正文 + **嵌套的评论**（评论与动态共用同一条 CEK）。
 * 一次查询把这一屏所有动态的包裹取回来，逐条解开（解不开就留 null → 显示占位）。
 */
export async function decryptTimelineRows(rows) {
  const list = rows ?? []
  if (list.length === 0) return list
  if (!currentUserId || !currentIdentity?.privateKey) return list
  const withCipher = list.filter((m) => m?.ciphertext || (m?.comments ?? []).some((c) => c?.ciphertext))
  if (withCipher.length === 0) return list
  const ids = withCipher.map((m) => m.id)
  // ⚠️ 必须显式筛"我自己那一份"：读策略允许动态作者看到自己动态的所有包裹
  //    （那是为了让 INSERT ... RETURNING 能通过），所以不筛就会拿到**别人那份**，
  //    用它去解当然解不开（实测：发布者自己反而读不到自己的动态）。
  const { data: keyRows, error } = await supabase
    .from('moment_keys')
    .select('moment_id, iv, wrapped')
    .eq('user_id', currentUserId)
    .in('moment_id', ids)
  if (error) return list
  const byMoment = new Map()
  for (const r of keyRows ?? []) byMoment.set(r.moment_id, r)

  const out = []
  for (const m of list) {
    if (!m?.ciphertext && !(m?.comments ?? []).some((c) => c?.ciphertext)) { out.push(m); continue }
    let cek = momentKeys.get(m.id) ?? null
    if (!cek) {
      const wrap = byMoment.get(m.id)
      const authorJwk = await peerKeyInfo(m.user_id).catch(() => null)
      if (wrap && authorJwk) {
        try {
          const kek = await deriveWrapKek(m.user_id, authorJwk, ['unwrapKey'])
          cek = await crypto.subtle.unwrapKey(
            'raw', fromB64(wrap.wrapped), kek,
            { name: 'AES-GCM', iv: fromB64(wrap.iv) },
            { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
          )
          momentKeys.set(m.id, cek)
        } catch { cek = null }
      }
    }
    const content = m.ciphertext ? await decryptCircleText(cek, m) : (m.content ?? null)
    const comments = []
    for (const c of m.comments ?? []) {
      comments.push(c?.ciphertext ? { ...c, content: await decryptCircleText(cek, c) } : c)
    }
    out.push({ ...m, content, comments })
  }
  return out
}

/**
 * 换密码（无感版）：**不需要旧密码** —— 直接用内存里已解锁的 DEK / 身份私钥重包。
 * 旧密码留给"设备锁着时"的场景（`rekeyForNewPassword`）。
 */
export async function rekeyWithUnlockedKeys(userId, newPassword, email) {
  if (!currentDek || !currentUserId || currentUserId !== userId) {
    return { ok: false, reason: '当前会话还没解锁' }
  }
  const identityJwk = currentIdentity
    ? await crypto.subtle.exportKey('jwk', currentIdentity.privateKey)
    : null

  const newSalt = toB64(crypto.getRandomValues(new Uint8Array(16)))
  const newKek = await deriveKek(newPassword, email, newSalt)
  const dekIv = crypto.getRandomValues(new Uint8Array(12))
  const dekWrapped = await crypto.subtle.wrapKey('raw', currentDek, newKek, { name: 'AES-GCM', iv: dekIv })

  const patch = {
    kek_salt: newSalt,
    kek_iterations: KEK_ITERATIONS,
    dek_iv: toB64(dekIv),
    dek_wrapped: toB64(dekWrapped),
    updated_at: new Date().toISOString(),
  }
  if (identityJwk) {
    const idKey = await crypto.subtle.importKey('jwk', identityJwk, IDENTITY_ALGO, true, ['deriveBits'])
    const idIv = crypto.getRandomValues(new Uint8Array(12))
    patch.identity_iv = toB64(idIv)
    patch.identity_wrapped = toB64(await crypto.subtle.wrapKey('jwk', idKey, newKek, { name: 'AES-GCM', iv: idIv }))
  }

  const { error } = await supabase.from('user_keys').update(patch).eq('user_id', userId)
  if (error) return { ok: false, reason: error.message }
  return { ok: true }
}

// ── 设备上缓存 DEK（阶段 1 用）──────────────────────────────────
// 为什么需要：浏览器会话能保留好几周，不能每次打开都让用户输密码（那就不是"无感"了）。
// ⚠️ 诚实说明：这等于把钥匙放在这台设备上（用本机随机串包一层，只是避免明文摆放）。
//    我们防的是**服务器/云**，不是"拿到你解锁手机的人" —— 与之前的取舍一致。
const DEVICE_KEY = 'moments_dek_cache_v1'

function deviceSecret() {
  try {
    let s = localStorage.getItem('moments_device_secret_v1')
    if (!s) {
      s = toB64(crypto.getRandomValues(new Uint8Array(32)))
      localStorage.setItem('moments_device_secret_v1', s)
    }
    return s
  } catch {
    return null
  }
}

/** 把 DEK 缓存到本机（包一层，避免明文摆放） */
export async function cacheDekOnDevice(userId) {
  const secret = deviceSecret()
  if (!secret || !currentDek) return false
  try {
    // ⚠️ 必须用 base64 解码后的 32 字节；直接 encode(base64 字符串) 是 44 字节，
    //    不是合法 AES 长度，importKey 会直接抛 InvalidAccessError（实测踩到：缓存一直写不进去）
    const kek = await crypto.subtle.importKey('raw', fromB64(secret), { name: 'AES-GCM' }, false, ['encrypt'])
    const raw = await crypto.subtle.exportKey('raw', currentDek)
    const identityJwk = currentIdentity ? await crypto.subtle.exportKey('jwk', currentIdentity.privateKey) : null
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const payload = JSON.stringify({ dek: toB64(raw), identity: identityJwk })
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, te.encode(payload))
    localStorage.setItem(DEVICE_KEY, JSON.stringify({ uid: userId, iv: toB64(iv), ct: toB64(ct) }))
    return true
  } catch (err) {
    console.warn('[crypto] 缓存 DEK 失败:', err?.message)
    return false
  }
}

/** 从本机缓存恢复 DEK（免输密码） */
export async function loadCachedDek(userId) {
  const secret = deviceSecret()
  if (!secret || !userId) return false
  try {
    const raw = JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null')
    if (!raw || raw.uid !== userId) return false
    const kek = await crypto.subtle.importKey('raw', fromB64(secret), { name: 'AES-GCM' }, false, ['decrypt'])
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(raw.iv) }, kek, fromB64(raw.ct))
    const parsed = JSON.parse(td.decode(plain))
    currentDek = await crypto.subtle.importKey('raw', fromB64(parsed.dek), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'])
    currentIdentity = parsed.identity
      ? { privateKey: await crypto.subtle.importKey('jwk', parsed.identity, IDENTITY_ALGO, true, ['deriveBits']), publicJwk: null }
      : null
    currentUserId = userId
    bumpUnlock()
    return true
  } catch {
    return false
  }
}

export function clearCachedDek() {
  try { localStorage.removeItem(DEVICE_KEY) } catch { /* 忽略 */ }
}

/**
 * 测试/排障用的只读把手（**不含任何密钥材料**，只暴露"能不能解密"这种能力）。
 *
 * 为什么要挂在 window 上：验证脚本如果自己去 `import('/moments/src/lib/crypto.js')`，
 * 拿到的可能是**另一个模块实例**（HMR 会给模块加 `?t=` 查询串，同一份源码可能有两个实例），
 * 于是 `isUnlocked()` 明明在应用里是 true、测试里却是 false（实测踩到，白查了半天）。
 */
if (typeof window !== 'undefined') {
  window.__momentsCrypto = {
    isUnlocked,
    dekFingerprint,
    encryptText,
    decryptText,
    user: () => currentUserId,
    unlockVersion: unlockStateVersion,
    conversationFingerprint,
    encryptForPeer,
    decryptForPeer,
    circleReady,
    createMomentKey,
    encryptImageBytes,
    decryptImageBytes,
    looksLikeImage,
    fetchAndDecryptImage,
    momentKey,
    encryptCircleText,
    decryptCircleText,
    cacheState: () => {
      try { return !!localStorage.getItem('moments_dek_cache_v1') } catch { return false }
    },
  }
}

/** DEK 指纹（测试与排障用：不泄露密钥本身） */
export async function dekFingerprint() {
  if (!currentDek) return null
  const raw = await crypto.subtle.exportKey('raw', currentDek)
  const digest = await crypto.subtle.digest('SHA-256', raw)
  return toB64(digest).slice(0, 12)
}
