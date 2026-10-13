import { supabase } from '../supabaseClient'

/**
 * 私聊文字的端到端加密（阶段 1，2026-10-12）。
 *
 * ── 目标 ────────────────────────────────────────────────────────
 * 服务器（包括云厂商、拿到 Management token 的人）**只看到密文**。
 * 明文只在两台设备的内存里出现，落库前就加密好了。
 *
 * ── 密码学（都用浏览器内置 WebCrypto，没有第三方库）──────────────
 *   身份密钥：**ECDH P-256**（长期，一人一对）
 *   会话密钥：随机 **AES-GCM 256**（一段私聊一个）
 *   包裹密钥：ECDH 共享秘密 → HKDF-SHA256 → AES-GCM（用来包会话密钥）
 *   恢复码：PBKDF2-SHA256(21 万次) → AES-GCM（用来包身份私钥）
 *
 * 会话密钥怎么让双方都拿到、又不让服务器拿到：
 *   A 生成 CK 后，**分别用"只有 A 能算出的 KEK"和"只有 B 能算出的 KEK"各包一份**存进 `dm_keys`：
 *     · A 那份用 ECDH(A私钥, A公钥) —— 只有 A 的私钥能算出
 *     · B 那份用 ECDH(A私钥, B公钥) —— B 用 ECDH(B私钥, A公钥) 算出同一个值
 *   服务器手里只有两坨密文。
 *
 * ── 已知边界（诚实写在这里，也写进文档）──────────────────────────
 *   · **元数据不加密**：谁、什么时候、发给了谁、有没有图片、消息多长，服务器都能看到。
 *   · **不防设备被拿到**：私钥存在设备本地（localStorage），解锁设备的人能看到明文。
 *     我们防的是"服务器/云"。
 *   · **同一段会话的两个人共用一把对称密钥**，所以技术上对方可以伪造"你发的"消息
 *     （没有做数字签名）。对两人私聊来说这是可接受的取舍。
 *   · **图片与动态还没加密**（阶段 2/3）。
 */

const ALGO_IDENTITY = { name: 'ECDH', namedCurve: 'P-256' }
const KEK_INFO = 'moments-dm-kek-v1'
const CK_INFO = 'moments-dm-ck-v1'
// PBKDF2 迭代次数：密码/恢复码都用同一档强度（2026-10-12 从 21 万提到 60 万：
// 密码那份可以被离线爆破，多拖一点时间。历史行按自己记录的次数解，不受影响）
const RECOVERY_ITERATIONS = 600000
/** 加密功能要求的最小登录密码长度（使用者 2026-10-12 选定） */
export const CRYPTO_PASSWORD_MIN = 10
const LS_PRIVATE = 'moments_e2e_identity_v1'
const LS_PENDING_CODE = 'moments_e2e_recovery_pending_v1'
const SCHEME = 'ecdh-p256-aesgcm-v1'

const te = new TextEncoder()
const td = new TextDecoder()

// ── base64 小工具（浏览器没有内置的 bytes→base64）────────────────
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

// ── 身份密钥 ─────────────────────────────────────────────────────
export async function generateIdentityPair() {
  const pair = await crypto.subtle.generateKey(ALGO_IDENTITY, true, ['deriveBits'])
  const [publicKey, privateKey] = await Promise.all([
    crypto.subtle.exportKey('jwk', pair.publicKey),
    crypto.subtle.exportKey('jwk', pair.privateKey),
  ])
  return { publicKey, privateKey }
}

function readLocalIdentity() {
  try {
    const raw = localStorage.getItem(LS_PRIVATE)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.privateKey?.d || !parsed?.publicKey?.x) return null
    return parsed
  } catch {
    return null
  }
}

function writeLocalIdentity(identity) {
  try {
    localStorage.setItem(LS_PRIVATE, JSON.stringify(identity))
  } catch {
    /* 存不下就算了（隐私模式）：这一次会话仍然能用，刷新后要重新恢复 */
  }
}

/** 本机有没有私钥（用来判断要不要提示"用恢复码恢复"） */
export function hasLocalIdentity() {
  return !!readLocalIdentity()
}

/** 本机身份公钥（给界面显示用） */
export function localPublicKey() {
  return readLocalIdentity()?.publicKey ?? null
}

async function importPrivateKey(jwk) {
  return crypto.subtle.importKey('jwk', jwk, ALGO_IDENTITY, false, ['deriveBits'])
}
async function importPublicKey(jwk) {
  return crypto.subtle.importKey('jwk', jwk, ALGO_IDENTITY, false, [])
}

/**
 * 包裹密钥：ECDH(我的私钥, 对方公钥) → HKDF-SHA256 → AES-GCM。
 * ⚠️ ECDH(A私, B公) 与 ECDH(B私, A公) 得到同一个值 —— 这正是"双方都能解开自己那份"的基础。
 */
export async function deriveWrappingKey(privateJwk, publicJwk, info = KEK_INFO) {
  return deriveKek(privateJwk, publicJwk, info)
}

async function deriveKek(privateJwk, publicJwk, info) {
  const [priv, pub] = await Promise.all([importPrivateKey(privateJwk), importPublicKey(publicJwk)])
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256)
  const hkdfKey = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

/** 用包裹密钥把一段原始对称密钥包成密文（返回 base64） */
export async function wrapConversationKey(kek, rawKeyBytes) {
  return wrapRawKey(kek, rawKeyBytes)
}

/** 解开被包裹的对称密钥 */
export async function unwrapConversationKey(kek, ivB64, wrappedB64) {
  return unwrapRawKey(kek, ivB64, wrappedB64)
}

/** 把原始密钥字节导入成可用的 AES-GCM 密钥 */
export async function importConversationKey(rawBytes) {
  return importCk(rawBytes)
}

async function wrapRawKey(kek, rawKeyBytes) {
  const key = await crypto.subtle.importKey('raw', rawKeyBytes, 'AES-GCM', true, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await crypto.subtle.wrapKey('raw', key, kek, { name: 'AES-GCM', iv })
  return { iv: toB64(iv), wrapped: toB64(wrapped) }
}

async function unwrapRawKey(kek, ivB64, wrappedB64) {
  const raw = await crypto.subtle.unwrapKey(
    'raw',
    fromB64(wrappedB64),
    kek,
    { name: 'AES-GCM', iv: fromB64(ivB64) },
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
  return crypto.subtle.exportKey('raw', raw)
}

async function importCk(rawBytes) {
  return crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

/** 会话密钥：本机这把私钥能算出的那份 KEK */
function selfKek(privateJwk, publicJwk) {
  return deriveKek(privateJwk, publicJwk, KEK_INFO)
}

// ── 恢复码 ───────────────────────────────────────────────────────
// 32 个字符去掉容易看错的 I/L/O/U → 20 位 ≈ 100 bit 熵，够用且能抄下来
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function generateRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  let out = ''
  for (let i = 0; i < 20; i += 1) {
    out += ALPHABET[bytes[i] % 32]
    if (i % 5 === 4 && i !== 19) out += '-'
  }
  return out
}

/** 规范化用户输入的恢复码（去掉分隔符、统一大写、把常见误输入纠正回来） */
export function normalizeRecoveryCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
}

async function passwordKek(secret, saltB64, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(String(secret)), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromB64(saltB64), iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  )
}

/**
 * 用恢复码把身份私钥包起来（上传到 key_backups，服务器打不开）。
 * ⚠️ 这里用 `wrapKey('jwk', …)` 而不是 `encrypt`：包裹密钥的 usages 是
 *    `['wrapKey','unwrapKey']`，用 encrypt 会直接抛 InvalidAccessError（实测踩到过）。
 */
/**
 * 用任意"秘密"（恢复码 / 登录密码）把身份私钥包起来。
 * 两者只差在"秘密"是什么，密码学流程完全一样（PBKDF2 → AES-GCM → wrapKey('jwk')）。
 */
async function wrapPrivateWithSecret(privateJwk, secret, iterations = RECOVERY_ITERATIONS) {
  const salt = toB64(crypto.getRandomValues(new Uint8Array(16)))
  const kek = await passwordKek(secret, salt, iterations)
  const key = await crypto.subtle.importKey('jwk', privateJwk, ALGO_IDENTITY, true, ['deriveBits'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await crypto.subtle.wrapKey('jwk', key, kek, { name: 'AES-GCM', iv })
  return { salt, iv: toB64(iv), wrapped: toB64(wrapped), iterations }
}

async function unwrapPrivateWithSecret(secret, backup) {
  const kek = await passwordKek(secret, backup.salt, backup.iterations || RECOVERY_ITERATIONS)
  const key = await crypto.subtle.unwrapKey(
    'jwk',
    fromB64(backup.wrapped),
    kek,
    { name: 'AES-GCM', iv: fromB64(backup.iv) },
    ALGO_IDENTITY,
    true,
    ['deriveBits'],
  )
  return crypto.subtle.exportKey('jwk', key)
}

export async function wrapPrivateWithRecovery(privateJwk, code) {
  return wrapPrivateWithSecret(privateJwk, normalizeRecoveryCode(code))
}

/** 用恢复码解回身份私钥 */
export async function unwrapPrivateWithRecovery(code, backup) {
  return unwrapPrivateWithSecret(normalizeRecoveryCode(code), backup)
}

// ── "钥匙跟着账号走"：用登录密码再包一份（2026-10-12）────────────
//
// 为什么：换设备时输入恢复码很麻烦。改成"登录时输密码的那一刻就能自动解开"。
// 两份并存：密码那份**方便**，恢复码那份是**强兜底**（20 位 ≈100bit，爆不动）。
// ⚠️ 安全代价：密码那份可以被拿到数据库的人离线爆破 —— 所以要求登录密码 ≥10 位
//    （`CRYPTO_PASSWORD_MIN`），并在界面/文档里写明。

/** 用登录密码保存一份包裹（覆盖旧的） */
export async function savePasswordBackup(userId, privateJwk, password) {
  const wrapped = await wrapPrivateWithSecret(privateJwk, password)
  const { error } = await supabase.from('key_backups').upsert({
    user_id: userId,
    pw_salt: wrapped.salt,
    pw_iv: wrapped.iv,
    pw_wrapped: wrapped.wrapped,
    pw_iterations: wrapped.iterations,
    pw_updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' })
  if (error) throw new Error(error.message)
}

/** 服务器上有没有"密码包裹" */
async function readPasswordBackup(userId) {
  const { data, error } = await supabase
    .from('key_backups')
    .select('pw_salt, pw_iv, pw_wrapped, pw_iterations')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return null
  if (!data?.pw_wrapped) return null
  return { salt: data.pw_salt, iv: data.pw_iv, wrapped: data.pw_wrapped, iterations: data.pw_iterations }
}

/**
 * 在**登录/注册**时调用（此时手里有密码）——这是"零操作"的关键：
 *   · 本机没有钥匙 + 服务器有密码包裹 → 用密码解开，钥匙自动落到这台设备上（不用恢复码）
 *   · 本机有钥匙 → 确认服务器上那份是不是当前密码包的；不是（换过密码/第一次）就重包一份
 * @returns {Promise<{restored: boolean, saved: boolean, reason?: string}>}
 */
export async function syncIdentityWithPassword(userId, password) {
  if (!userId || !password) return { restored: false, saved: false, reason: '缺少参数' }
  if (typeof crypto === 'undefined' || !crypto.subtle) return { restored: false, saved: false, reason: '不支持加密' }
  if (String(password).length < CRYPTO_PASSWORD_MIN) {
    return { restored: false, saved: false, reason: `密码少于 ${CRYPTO_PASSWORD_MIN} 位，没有用它保存钥匙` }
  }

  const local = readLocalIdentity()
  const backup = await readPasswordBackup(userId)

  if (!local) {
    if (!backup) return { restored: false, saved: false, reason: '服务器上没有密码包裹' }
    try {
      const privateKey = await unwrapPrivateWithSecret(password, backup)
      writeLocalIdentity({
        privateKey,
        publicKey: { kty: 'EC', crv: 'P-256', x: privateKey.x, y: privateKey.y, ext: true },
        createdAt: Date.now(),
      })
      return { restored: true, saved: false }
    } catch {
      return { restored: false, saved: false, reason: '密码对不上（可能改过密码）' }
    }
  }

  // 本机已有钥匙：看现有密码包裹能不能用当前密码解开 → 能就说明密码没变，不用重包
  if (backup) {
    try {
      await unwrapPrivateWithSecret(password, backup)
      return { restored: false, saved: false }
    } catch {
      // 解不开 = 改过密码（或换过钥匙）→ 用当前密码重包一份
    }
  }
  try {
    await savePasswordBackup(userId, local.privateKey, password)
    return { restored: false, saved: true }
  } catch (err) {
    return { restored: false, saved: false, reason: err?.message }
  }
}

/** 用**登录密码**恢复（新设备；在没有恢复码的情况下用） */
export async function restoreIdentityWithPassword(userId, password) {
  const backup = await readPasswordBackup(userId)
  if (!backup) throw new Error('服务器上没有用密码保存的钥匙（可能当初密码太短，或还没设置过）')
  let privateKey
  try {
    privateKey = await unwrapPrivateWithSecret(password, backup)
  } catch {
    throw new Error('密码对不上（如果你改过密码，请用最新的那个）')
  }
  const identity = {
    privateKey,
    publicKey: { kty: 'EC', crv: 'P-256', x: privateKey.x, y: privateKey.y, ext: true },
    createdAt: Date.now(),
  }
  writeLocalIdentity(identity)
  return identity
}

// ── 身份：读本机的、没有就生成并上传公钥 ─────────────────────────
/**
 * 保证本机有身份密钥。
 *
 * ⚠️ 关键规则（踩过坑）：**服务器上已经有公钥、而本机没有私钥时，绝对不能生成新密钥** ——
 *    那会把自己的公钥覆盖掉，对方按老公钥包好的会话密钥就再也解不开（历史读不回来）。
 *    那种情况只能走"用恢复码恢复"。
 *
 * @returns {Promise<{identity: object|null, created: boolean, recoveryCode: string|null, needsRestore: boolean}>}
 */
// ⚠️ 单飞（single-flight）：登录页和 AuthContext 会**同时**调用这个函数，
//    如果两个调用都判断"本机没有钥匙"→ 各自生成一对 → 后写的公钥覆盖前一个，
//    而本机留下的是另一把私钥 → **对方按错误公钥包的会话密钥就永远解不开**（实测踩到：
//    自己发自己读没问题、对方什么都看不到）。用一个共享 promise 保证只生成一次。
let identityInFlight = null

export async function ensureIdentity(userId) {
  if (identityInFlight) return identityInFlight
  identityInFlight = ensureIdentityInner(userId).finally(() => { identityInFlight = null })
  return identityInFlight
}

async function ensureIdentityInner(userId) {
  if (!userId || typeof crypto === 'undefined' || !crypto.subtle) {
    return { identity: null, created: false, recoveryCode: null, needsRestore: false }
  }

  let identity = readLocalIdentity()
  let created = false
  let recoveryCode = null

  // 本机没有私钥时，先看服务器上有没有公钥：有就是"另一台设备"，必须用恢复码，不能新生成
  if (!identity) {
    try {
      const { data } = await supabase.from('profiles').select('public_key').eq('id', userId).maybeSingle()
      if (data?.public_key?.x) {
        return { identity: null, created: false, recoveryCode: null, needsRestore: true }
      }
    } catch { /* 查不到就当作"没有公钥"继续，后面生成时会再校验一次 */ }
  }

  if (!identity) {
    const jwks = await generateIdentityPair()
    identity = { ...jwks, createdAt: Date.now() }
    writeLocalIdentity(identity)
    created = true
    // 恢复码：生成、包裹私钥、上传备份（服务器只有密文）
    recoveryCode = generateRecoveryCode()
    try {
      const backup = await wrapPrivateWithRecovery(identity.privateKey, recoveryCode)
      await supabase.from('key_backups').upsert({ user_id: userId, ...backup, updated_at: new Date().toISOString() })
      // 等使用者确认抄下来之前，一直提示
      localStorage.setItem(LS_PENDING_CODE, recoveryCode)
    } catch (err) {
      console.warn('[e2e] 恢复码备份上传失败（不影响加密，但换设备会恢复不了）:', err?.message)
    }
  }

  // 公钥上传（幂等）：自己的 public_key 为空或与本地不一致时更新
  try {
    const { data } = await supabase.from('profiles').select('public_key').eq('id', userId).maybeSingle()
    const mine = data?.public_key
    if (!mine || mine.x !== identity.publicKey.x || mine.y !== identity.publicKey.y) {
      await supabase.from('profiles').update({ public_key: identity.publicKey }).eq('id', userId)
    }
  } catch (err) {
    console.warn('[e2e] 公钥上传失败:', err?.message)
  }

  return { identity, created, recoveryCode, needsRestore: false }
}

/** 待确认的恢复码（界面用它提示"请抄下来"） */
export function pendingRecoveryCode() {
  try {
    return localStorage.getItem(LS_PENDING_CODE)
  } catch {
    return null
  }
}

/** 使用者确认已抄下 → 不再提示 */
export function acknowledgeRecoveryCode() {
  try {
    localStorage.removeItem(LS_PENDING_CODE)
  } catch { /* 忽略 */ }
}

/** 用恢复码在本机恢复私钥（换设备 / 清过缓存） */
export async function restoreIdentityWithCode(userId, code) {
  const { data, error } = await supabase
    .from('key_backups')
    .select('salt, iv, wrapped, iterations')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('服务器上没有你的密钥备份（可能当初没生成成功）')

  let privateKey
  try {
    privateKey = await unwrapPrivateWithRecovery(code, data)
  } catch {
    throw new Error('恢复码不对（请检查有没有抄错）')
  }
  const publicJwk = localPublicKey()         // 有就用本机的，没有就用私钥里的 x/y 重建
  const identity = {
    privateKey,
    publicKey: publicJwk && publicJwk.x === privateKey.x
      ? publicJwk
      : { kty: 'EC', crv: 'P-256', x: privateKey.x, y: privateKey.y, ext: true },
    createdAt: Date.now(),
  }
  writeLocalIdentity(identity)
  return identity
}

// ── 会话密钥：读出来或创建 ───────────────────────────────────────
const ckCache = new Map()   // `${a}|${b}` → CryptoKey

/**
 * 拿到这段会话的对称密钥。
 * @returns {Promise<CryptoKey|null>} null = 还不能加密（对方还没生成密钥 / 没备份等）
 */
export async function ensureConversationKey(me, peer, { publicKeyOfPeer = null } = {}) {
  if (!me || !peer || me === peer) return null
  const a = me < peer ? me : peer
  const b = me < peer ? peer : me
  const cacheKey = `${a}|${b}`
  if (ckCache.has(cacheKey)) return ckCache.get(cacheKey)

  const identity = readLocalIdentity()
  if (!identity) return null
  const kekSelf = await selfKek(identity.privateKey, identity.publicKey)

  /**
   * 解开"我那一份"要用哪把包裹密钥？
   *   · 这一段会话密钥**是我自己创建的** → 我那份是用 ECDH(我私, 我公) 包的（自己包给自己）
   *   · **是对方创建的** → 我那份是用 ECDH(对方私, 我公) 包的，我这边要用
   *     ECDH(我私, 对方公) 来解 —— 这两个值相等（ECDH 的对称性）。
   * ⚠️ 这里踩过一次：一开始不分情况、一律用"自己包给自己"的密钥去解，
   *    结果自己发自己读没问题、**对方永远解不开**（会话密钥拿不到 → 退回明文）。
   */
  async function kekFor(rowWrap) {
    const creator = rowWrap.created_by
    if (!creator || creator === me) return kekSelf
    const { data: creatorProfile } = await supabase
      .from('profiles').select('public_key').eq('id', creator).maybeSingle()
    if (!creatorProfile?.public_key?.x) return null
    return deriveKek(identity.privateKey, creatorProfile.public_key, KEK_INFO)
  }

  // ① 已经有会话密钥？
  const { data: existing } = await supabase
    .from('dm_keys')
    .select('ck_for_a, iv_a, ck_for_b, iv_b, created_by')
    .eq('a', a).eq('b', b)
    .maybeSingle()
  if (existing) {
    const iv = me === a ? existing.iv_a : existing.iv_b
    const wrapped = me === a ? existing.ck_for_a : existing.ck_for_b
    try {
      const kek = await kekFor(existing)
      if (!kek) return null
      const ck = await importCk(await unwrapRawKey(kek, iv, wrapped))
      ckCache.set(cacheKey, ck)
      return ck
    } catch {
      // 本机这把私钥解不开（例如换了设备还没恢复）→ 当作"还没有"
      return null
    }
  }

  // ② 没有 → 需要对方的公钥才能创建
  let peerPub = publicKeyOfPeer
  if (!peerPub) {
    const { data: prof } = await supabase.from('profiles').select('public_key').eq('id', peer).maybeSingle()
    peerPub = prof?.public_key ?? null
  }
  if (!peerPub?.x) return null      // 对方还没开启加密

  const rawCk = crypto.getRandomValues(new Uint8Array(32))
  const kekPeer = await deriveKek(identity.privateKey, peerPub, KEK_INFO)
  const forMe = await wrapRawKey(kekSelf, rawCk)
  const forPeer = await wrapRawKey(kekPeer, rawCk)

  const row = me === a
    ? { a, b, ck_for_a: forMe.wrapped, iv_a: forMe.iv, ck_for_b: forPeer.wrapped, iv_b: forPeer.iv, created_by: me, scheme: SCHEME }
    : { a, b, ck_for_a: forPeer.wrapped, iv_a: forPeer.iv, ck_for_b: forMe.wrapped, iv_b: forMe.iv, created_by: me, scheme: SCHEME }

  const { error } = await supabase.from('dm_keys').insert(row)
  if (error) {
    // 并发：对方刚好也创建了 → 重新读一次
    const { data: again } = await supabase
      .from('dm_keys').select('ck_for_a, iv_a, ck_for_b, iv_b, created_by').eq('a', a).eq('b', b).maybeSingle()
    if (!again) return null
    const iv = me === a ? again.iv_a : again.iv_b
    const wrapped = me === a ? again.ck_for_a : again.ck_for_b
    const kek = await kekFor(again)
    if (!kek) return null
    const ck = await importCk(await unwrapRawKey(kek, iv, wrapped))
    ckCache.set(cacheKey, ck)
    return ck
  }

  const ck = await importCk(rawCk)
  ckCache.set(cacheKey, ck)
  return ck
}

/**
 * 恢复入口的便捷写法：先试密码，失败再给提示（界面可以再让用户改用恢复码）。
 * 之所以要"先密码"：使用者换设备时手里一定有密码，不一定有恢复码。
 */
export async function restoreIdentityByPasswordOrCode(userId, password) {
  return restoreIdentityWithPassword(userId, String(password || '').trim())
}

/** 只读缓存（同步）：已经解出来的会话密钥 */
export function cachedConversationKey(me, peer) {
  if (!me || !peer) return null
  const a = me < peer ? me : peer
  const b = me < peer ? peer : me
  return ckCache.get(`${a}|${b}`) ?? null
}

// ── 加解密 ───────────────────────────────────────────────────────
export async function encryptText(ck, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, ck, te.encode(text))
  return { ciphertext: toB64(ct), iv: toB64(iv), scheme: SCHEME }
}

export async function decryptText(ck, ciphertext, iv) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, ck, fromB64(ciphertext))
  return td.decode(plain)
}

/**
 * 把一批消息里的密文就地解出来，写回本地副本的 `content`。
 * 这样界面上所有现有代码（气泡、引用、编辑框）都不用改。
 * 解不开的保留原文（显示成"加密消息"由调用方决定）。
 */
export async function decryptMessages(ck, messages) {
  if (!ck) return messages
  return Promise.all(messages.map(async (m) => {
    if (!m?.ciphertext || !m?.iv) return m
    try {
      return { ...m, content: await decryptText(ck, m.ciphertext, m.iv), decrypted: true }
    } catch {
      return { ...m, content: null, decrypted: false }
    }
  }))
}

/** 清掉内存里的会话密钥（登出时调用） */
export function clearConversationKeys() {
  ckCache.clear()
}

/** 本机身份密钥是否与服务器上记录的公钥一致（不一致说明这台设备是"另一把钥匙"） */
export function identityMatches(serverPublicKey) {
  const mine = readLocalIdentity()
  if (!mine || !serverPublicKey) return false
  return mine.publicKey.x === serverPublicKey.x && mine.publicKey.y === serverPublicKey.y
}
