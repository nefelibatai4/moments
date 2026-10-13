import { supabase } from '../supabaseClient'

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

  // 顺便把公钥放到 profiles（别人要拿它给你包恢复包裹）
  await supabase.from('profiles').update({ public_key: jwks.publicKey }).eq('id', userId)

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
