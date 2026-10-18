import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabaseClient'
import { resolveSignedUrl, storagePathFromUrl, useSignedUrls } from './signedUrls'
import { clearRawCache, dropRaw, getRaw, putRaw } from './mediaCache'

/**
 * 图片的端到端加密（阶段 3，2026-10-13）。
 *
 * ── 思路 ────────────────────────────────────────────────────────
 * 上传前在设备上把**压缩后的图片字节**加密，桶里存的是密文；显示时下载密文、在本机解密成
 * `blob:` 地址给 `<img>`。密钥就是那条内容本来用的钥匙：
 *   · 私聊图片 → 会话密钥（双方由身份密钥 ECDH 得到，见 lib/crypto.js）
 *   · 动态图片 → 那条动态的 CEK（见 lib/crypto.js 的 momentKey）
 * 所以**不需要动数据库结构**：图片存在哪一行、用哪把钥匙，都由它所属的内容决定。
 *
 * ── 密文格式 ────────────────────────────────────────────────────
 *   `iv(12 字节) || AES-GCM 密文`（整体就是上传的那串字节）
 *
 * ── 老图怎么办（关键）────────────────────────────────────────────
 * 加密上线前传的图片是**明文**，桶里还躺着。判断办法是"看字节"：
 *   · 头几个字节是 JPEG/PNG/GIF/WebP 的魔数 → 这是老明文图，直接显示；
 *   · 否则按密文解，解出来还得像图片才认（解不开就当失败，绝不显示乱码）。
 * 这样**读路径天然向后兼容**，老图不会变成空气。
 * （历史明文的"补加密"由 lib/imageSync.js 在后台做，同样是尽力而为。）
 *
 * ── 取舍（诚实记录）─────────────────────────────────────────────
 *   · 每次显示都要"下载 + 解密"（AES-GCM 对几百 KB 是毫秒级；下载仍走 Service Worker
 *     的对象路径缓存，第二次打开不重新下载）。
 *   · 解密结果只在**内存**里缓存成 `blob:` 地址，登出时全部释放。
 *   · 头像（`avatars` 桶）**不加密**：它是"身份"不是"内容"，而且几乎每个界面都在渲染它。
 */

const IV_LEN = 12
const BUCKET = 'moment-images'
/** 内存里的"已解密图片地址"缓存（同一个对象路径只会解一次） */
const urlCache = new Map()     // locator → blob: 地址
const MAX_CACHED = 120

/** 头几个字节是不是已知图片格式（用来区分"老明文图"与"密文"） */
export function looksLikeImage(bytes) {
  const b = bytes
  if (!b || b.length < 12) return false
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true
  // WebP：RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true
  // HEIC / MP4 家族：....ftyp
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return true
  return false
}

/**
 * 头几个字节像不像视频（用来区分"老明文视频"与"密文"）。
 * ⚠️ 不能直接用 `looksLikeImage`：它把 `....ftyp` 一族（HEIC **和** MP4/MOV）都算图片，
 *    对视频来说会把 HEIC 误判成视频、把 MP4 误判成图片，两边都不对。
 */
export function looksLikeVideo(bytes) {
  const b = bytes
  if (!b || b.length < 12) return false
  // ISO BMFF 家族：....ftyp<brand> —— mp4 / mov / m4v 都是；排掉 heic/heix/mif1/msf1（那是图片）
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]).toLowerCase()
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'avif'].includes(brand)) return false
    return true
  }
  // WebM / Matroska：1A 45 DF A3
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true
  return false
}

/** 视频按文件后缀给 MIME（解密出来的是原始字节，`<video>` 需要知道类型） */
function videoMimeFromPath(locator) {
  const path = String(locator).split('?')[0].toLowerCase()
  if (path.endsWith('.mov')) return 'video/quicktime'
  if (path.endsWith('.webm')) return 'video/webm'
  if (path.endsWith('.m4v')) return 'video/x-m4v'
  return 'video/mp4'
}

/** 交给 `Blob` 的 MIME：图片按字节嗅探，视频按后缀（浏览器对视频的 MIME 更挑） */
function blobMime(bytes, locator, kind) {
  return kind === 'video' ? videoMimeFromPath(locator) : mimeOf(bytes)
}

function mimeOf(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif'
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp'
  if (bytes[4] === 0x66 && bytes[5] === 0x74) return 'image/heic'
  return 'application/octet-stream'
}

/** 明文图片字节 → `iv || 密文` */
export async function encryptImageBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes))
  const out = new Uint8Array(IV_LEN + ct.length)
  out.set(iv, 0)
  out.set(ct, IV_LEN)
  return out
}

/**
 * 桶里的字节 → 明文图片字节。
 * @returns {Promise<{bytes: Uint8Array, encrypted: boolean}|null>} 认不出来就返回 null
 */
export async function decryptImageBytes(key, raw, kind = 'image') {
  const sniff = kind === 'video' ? looksLikeVideo : looksLikeImage
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  // `kind='file'`（私聊里的任意文件）：**不做嗅探**，只解密。
  // 原因：文件不是图片、也不是视频，嗅探必然失败；而 AES-GCM 自带认证，
  // 钥匙不对会直接抛错，所以"解出来"的字节一定就是原文（不需要再猜格式）。
  if (kind === 'file') {
    if (!key || bytes.length <= IV_LEN) return null
    try {
      const plain = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.slice(0, IV_LEN) },
        key,
        bytes.slice(IV_LEN),
      ))
      return { bytes: plain, encrypted: true }
    } catch { return null }
  }
  if (sniff(bytes)) return { bytes, encrypted: false }   // 加密上线前的老明文
  if (!key || bytes.length <= IV_LEN) return null
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_LEN) },
      key,
      bytes.slice(IV_LEN),
    ))
    if (sniff(plain)) return { bytes: plain, encrypted: true }
  } catch { /* 解不开：钥匙不对或不是密文 */ }
  return null
}

/** 加密后上传。图片与视频共用（都是"字节进、密文出"，区别只在调用方的 path/MIME） */
export async function uploadEncryptedBytes(path, file, key) {
  if (!key) return { ok: false, reason: 'no-key' }
  try {
    const sealed = await encryptImageBytes(key, new Uint8Array(await file.arrayBuffer()))
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, new Blob([sealed], { type: 'application/octet-stream' }), {
        contentType: 'application/octet-stream',
      })
    if (error) return { ok: false, reason: error.message }
    // 原地覆盖了同一路径 → 本机密文缓存立刻作废
    dropRaw(path).catch(() => {})
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err?.message }
  }
}

/** 图片的加密上传（历史名字，等价于 uploadEncryptedBytes） */
export const uploadEncryptedImage = uploadEncryptedBytes

/** 下载 + 解密一个对象路径（`key` 为 null 时只处理老明文；`kind='video'` 时按视频嗅探） */
export async function fetchAndDecryptImage(signedUrl, key, kind = 'image') {
  const cachePath = storagePathFromUrl(signedUrl)
  // 先看本机有没有**密文**（同一张图重复打开 → 0 字节流量；这是流量账单的头号来源）
  if (cachePath) {
    const cached = await getRaw(cachePath)
    if (cached) {
      const out = await decryptImageBytes(key, cached, kind)
      if (out) return out
      // 缓存里这份解不开（例如对象被换过）→ 作废，走网络
      dropRaw(cachePath).catch(() => {})
    }
  }
  // ⚠️ 后台"补加密"会**原地覆盖**同一个对象：对方正好在这时取图就可能拿到一半/失败。
  //    所以这里失败重试一次（600ms 后），而不是让这张图永久空着。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(signedUrl, { credentials: 'omit' })
      if (res.ok) {
        const raw = new Uint8Array(await res.arrayBuffer())
        const out = await decryptImageBytes(key, raw, kind)
        if (out) {
          if (cachePath) putRaw(cachePath, raw).catch(() => {})
          return out
        }
        if (attempt === 1) {
          const head = [...raw.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
          console.warn('[media] 下载到了但解不开', kind, 'len=' + raw.length, 'head=' + head, 'hasKey=' + !!key)
        }
      } else if (attempt === 1) {
        console.warn('[media] 下载失败:', res.status, signedUrl.slice(0, 80))
      }
    } catch (err) {
      if (attempt === 1) console.warn('[media] 下载异常:', err?.message)
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 600))
  }
  return null
}

/**
 * 每个对象的"尝试次数"与"这辈子都解不开"名单（**跨渲染、跨挂载累计**）。
 *
 * ⚠️ 为什么必须有这两样（2026-10-15 实测）：解不开的图（例如"在我加入圈子之前加密的
 *    动态图"、或钥匙还没交付时）会让重试永远失败；只要有任何东西让它重渲染一次，
 *    就会再下一次，实测**每打开一次应用同一个对象被请求 34~54 次、30 MB+**
 *    —— 这既是流量账单的头号来源，也是纯浪费的电。
 *    现在：① 明确"没有钥匙"就当场放弃（这不是网络抖动，重试没有意义）；
 *          ② 每个对象每个会话最多试 3 次，从机制上封顶。
 */
const attemptCounts = new Map()          // 真正"带钥匙去取"的次数（防流量黑洞）
const noKeyAttempts = new Map()          // "还没钥匙"时试了几次（给钥匙一点时间到，但也要封顶）
const MAX_ATTEMPTS_PER_OBJECT = 3
/**
 * 没有钥匙时最多试几次。
 *
 * 为什么要单独一个额度：身份密钥/会话密钥/CEK 都是**页面打开后才慢慢就绪**的，
 * 而这个 hook 的重渲染只由"签名地址到了""重试计数"驱动 —— 如果第一次没钥匙就把额度
 * （`MAX_ATTEMPTS_PER_OBJECT`）烧掉，钥匙 3 秒后才到就**永远接不上**了
 * （2026-10-15 实测：历史私聊图在对方设备上一直空白）。
 * 所以：没钥匙时**最多真的去取一次字节**（就为了"老明文内容没有钥匙也能显示"这一件事），
 * 之后每一轮**只是等钥匙**、不再发请求（0 流量）；重试照排（1s/3s/8s），钥匙一到就正常取。
 * 实测口径：`verify-image-no-loop` 里"每次打开最多 2 次请求"（修前是 30+ 次的流量黑洞）。
 */
const MAX_NO_KEY_ATTEMPTS = 1

/** 登出/换账号时释放内存里所有 `blob:` 地址（否则会把上一个人的内容留在内存里） */
export function clearImageCache() {
  for (const url of urlCache.values()) {
    try { URL.revokeObjectURL(url) } catch { /* 忽略 */ }
  }
  urlCache.clear()
  attemptCounts.clear()
  noKeyAttempts.clear()
  // 本机缓存的密文也一起清（换账号/退出登录时不该留在设备上）
  clearRawCache().catch(() => {})
}

/**
 * 解密成功的广播：**任何**一个实例解出来，所有在渲染这个对象的实例都要重画。
 *
 * ⚠️ 为什么必须有（2026-10-15 实测）：同一条内容可能同时挂在两个组件实例上
 *    （卡片 + 灯箱、时间线重挂载、StrictMode 双挂载…）。以前只有"自己解出来的那个实例"
 *    会 `setVersion` 重渲染，另一个实例的 `urlCache.has()` 是在它自己那次渲染里读的 →
 *    它就**永远停在封面/占位**，哪怕数据早就在缓存里了。视频那条尤其明显。
 */
const cacheListeners = new Set()

function remember(locator, url) {
  urlCache.set(locator, url)
  for (const cb of cacheListeners) { try { cb(locator) } catch { /* 订阅方自己的错 */ } }
  while (urlCache.size > MAX_CACHED) {
    const oldest = urlCache.keys().next().value
    const dead = urlCache.get(oldest)
    urlCache.delete(oldest)
    try { URL.revokeObjectURL(dead) } catch { /* 忽略 */ }
  }
}

/**
 * 一批内容图片（`moment-images`）→ **可以直接放进 `<img src>` 的地址**。
 * 返回的 Map 形状与 `useSignedUrls` 一致，所以组件里基本是drop-in 替换。
 *
 * @param {string[]} locators 存的那串定位符（`bucket:path`）
 * @param {{ resolveKey: () => Promise<CryptoKey|null> }} opts 怎么拿钥匙（由调用方按语境给）
 */
export function useContentImageUrls(locators, { resolveKey, kind = 'image' }) {
  const list = useMemo(() => (locators ?? []).filter(Boolean), [locators])
  const signed = useSignedUrls(list, BUCKET)
  // ⚠️ 依赖用"定位符 → 签名地址"的字符串指纹，而不是 Map/数组本身：
  //    `list` 每次渲染都是新数组、`signed` 的 Map 也可能重建，直接进依赖会无限循环。
  const fingerprint = list.map((l) => `${l}→${signed.get(l) ?? ''}`).join('|')
  const [version, setVersion] = useState(0)
  const [retry, setRetry] = useState(0)

  // 别人解出来也要通知我重画（见 remember 的说明）
  useEffect(() => {
    const cb = () => setVersion((v) => v + 1)
    cacheListeners.add(cb)
    return () => { cacheListeners.delete(cb) }
  }, [])

  useEffect(() => {
    let cancelled = false
    const storageOnes = list.filter((l) => storagePathFromUrl(l))
    const pending = storageOnes.filter((l) => (
      !urlCache.has(l)
      && (attemptCounts.get(l) ?? 0) < MAX_ATTEMPTS_PER_OBJECT
    ))
    if (pending.length === 0) return undefined
    let stillPending = false
    ;(async () => {
      // 有界重试（1s / 3s / 8s）：网络抖一下、或后台正在"原地补加密"时正好取图，都能自愈。
      // 但**额度用完就不再排**（否则重挂载一次就再来一轮，等于没有上限）。
      const scheduleRetry = () => {
        const hasBudget = pending.some((l) => (attemptCounts.get(l) ?? 0) < MAX_ATTEMPTS_PER_OBJECT)
        if (!cancelled && stillPending && hasBudget && retry < 3) {
          const wait = [1000, 3000, 8000][retry] ?? 8000
          setTimeout(() => { if (!cancelled) setRetry((r) => r + 1) }, wait)
        }
      }

      const key = await resolveKey().catch(() => null)
      if (!key) {
        // ⚠️ 「没有钥匙」**不等于**「看不到」：加密上线前的老明文图/视频就是这样，
        //    没有钥匙也照样能显示。所以这里给**一次**机会，但只给一次：
        //      · 取回来是明文 → 正常显示（向后兼容，历史内容不会变成空气）；
        //      · 取回来是密文 → 说明这条内容没给我包钥匙 → 认了，**不重试**
        //        （这正是"加入圈子之前的动态"那种情况；也只有这样才不会变成一个流量黑洞）。
        //    同时把"还没拿到钥匙（身份密钥刚在解锁、CEK 还在路上）"和上面这种区分开：
        //    前者要排重试（见 MAX_NO_KEY_ATTEMPTS），后者一次就够。
        for (const locator of pending) {
          const tried = noKeyAttempts.get(locator) ?? 0
          const url = signed.get(locator) ?? null
          // 这一轮不取字节（还没签名地址，或者"唯一的免费机会"已经用过了）→ 只等钥匙。
          // ⚠️ 仍然要 stillPending，否则重试链断掉、钥匙到了也没人再来问。
          if (!url || tried >= MAX_NO_KEY_ATTEMPTS) { stillPending = true; continue }
          noKeyAttempts.set(locator, tried + 1)
          try {
            const out = await fetchAndDecryptImage(url, null, kind)
            if (!out) {
              // 这次没钥匙、也不是明文 —— 但钥匙**可能马上就到**（身份密钥正在解锁、
              // 会话密钥还在算）→ 继续排重试去等它，但**不再重复下载**（不再耗流量）。
              stillPending = true
              console.warn('[media] 还没拿到钥匙（继续等，不重复下载）', kind, locator.slice(-22))
              continue
            }
            const objUrl = URL.createObjectURL(new Blob([out.bytes], { type: blobMime(out.bytes, locator, kind) }))
            remember(locator, objUrl)
            if (!cancelled) setVersion((v) => v + 1)
          } catch { stillPending = true }
        }
        scheduleRetry()
        return
      }
      for (const locator of pending) {
        if (cancelled) return
        if (urlCache.has(locator)) continue
        attemptCounts.set(locator, (attemptCounts.get(locator) ?? 0) + 1)
        try {
          // ⚠️ 先只用**批量签名**的结果（一屏多图必须合并成一次请求，这是既有的性能约定）。
          //    只有当重试都试过了还拿不到地址（批量那次真的失败了），才单独补签一个 ——
          //    否则每次渲染都自己签一遍，实测会把"1 次请求"变成 6 次。
          const url = signed.get(locator)
            ?? (retry >= 3 ? await resolveSignedUrl(BUCKET, locator).catch(() => null) : null)
          if (!url) { stillPending = true; continue }
          const out = await fetchAndDecryptImage(url, key, kind)
          if (!out) {
            stillPending = true
            // 只在这个对象已经用完额度时喊一次：线上排查"图/视频为什么不出来"就靠它
            if ((attemptCounts.get(locator) ?? 0) >= MAX_ATTEMPTS_PER_OBJECT) {
              console.warn('[media] 解不开（已放弃）', kind, locator.slice(-24))
            }
            continue
          }
          const objUrl = URL.createObjectURL(new Blob([out.bytes], { type: blobMime(out.bytes, locator, kind) }))
          remember(locator, objUrl)
          if (!cancelled) setVersion((v) => v + 1)
        } catch { stillPending = true }
      }
      scheduleRetry()
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, retry])

  return useMemo(() => {
    const out = new Map()
    for (const locator of list) {
      // 不是桶里的地址（外链图片、data:、测试用的 favicon）原样返回：
      // 它们不需要签名、更不需要解密。漏掉这一步，外链图会整片不显示。
      if (!storagePathFromUrl(locator)) { out.set(locator, locator); continue }
      const cached = urlCache.get(locator)
      if (cached) out.set(locator, cached)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, version, retry])
}
