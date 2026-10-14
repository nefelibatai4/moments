import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabaseClient'
import { resolveSignedUrl, storagePathFromUrl, useSignedUrls } from './signedUrls'

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
export async function decryptImageBytes(key, raw) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  if (looksLikeImage(bytes)) return { bytes, encrypted: false }   // 加密上线前的老明文图
  if (!key || bytes.length <= IV_LEN) return null
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_LEN) },
      key,
      bytes.slice(IV_LEN),
    ))
    if (looksLikeImage(plain)) return { bytes: plain, encrypted: true }
  } catch { /* 解不开：钥匙不对或不是密文 */ }
  return null
}

/** 加密后上传（拿不到钥匙就返回 false，由调用方决定要不要退回明文） */
export async function uploadEncryptedImage(path, file, key) {
  if (!key) return { ok: false, reason: 'no-key' }
  try {
    const sealed = await encryptImageBytes(key, new Uint8Array(await file.arrayBuffer()))
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, new Blob([sealed], { type: 'application/octet-stream' }), {
        contentType: 'application/octet-stream',
      })
    if (error) return { ok: false, reason: error.message }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err?.message }
  }
}

/** 下载 + 解密一个对象路径（`key` 为 null 时只处理老明文图） */
export async function fetchAndDecryptImage(signedUrl, key) {
  // ⚠️ 后台"补加密"会**原地覆盖**同一个对象：对方正好在这时取图就可能拿到一半/失败。
  //    所以这里失败重试一次（600ms 后），而不是让这张图永久空着。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(signedUrl, { credentials: 'omit' })
      if (res.ok) {
        const raw = new Uint8Array(await res.arrayBuffer())
        const out = await decryptImageBytes(key, raw)
        if (out) return out
      } else if (attempt === 1) {
        console.warn('[image] 下载失败:', res.status, signedUrl.slice(0, 80))
      }
    } catch (err) {
      if (attempt === 1) console.warn('[image] 下载异常:', err?.message)
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 600))
  }
  return null
}

/** 登出/换账号时释放内存里所有 `blob:` 地址（否则会把上一个人的内容留在内存里） */
export function clearImageCache() {
  for (const url of urlCache.values()) {
    try { URL.revokeObjectURL(url) } catch { /* 忽略 */ }
  }
  urlCache.clear()
}

function remember(locator, url) {
  urlCache.set(locator, url)
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
export function useContentImageUrls(locators, { resolveKey }) {
  const list = useMemo(() => (locators ?? []).filter(Boolean), [locators])
  const signed = useSignedUrls(list, BUCKET)
  // ⚠️ 依赖用"定位符 → 签名地址"的字符串指纹，而不是 Map/数组本身：
  //    `list` 每次渲染都是新数组、`signed` 的 Map 也可能重建，直接进依赖会无限循环。
  const fingerprint = list.map((l) => `${l}→${signed.get(l) ?? ''}`).join('|')
  const [version, setVersion] = useState(0)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let cancelled = false
    const storageOnes = list.filter((l) => storagePathFromUrl(l))
    const pending = storageOnes.filter((l) => !urlCache.has(l))
    if (pending.length === 0) return undefined
    let stillPending = false
    ;(async () => {
      const key = await resolveKey().catch(() => null)
      for (const locator of pending) {
        if (cancelled) return
        if (urlCache.has(locator)) continue
        try {
          // ⚠️ 先只用**批量签名**的结果（一屏多图必须合并成一次请求，这是既有的性能约定）。
          //    只有当重试都试过了还拿不到地址（批量那次真的失败了），才单独补签一个 ——
          //    否则每次渲染都自己签一遍，实测会把"1 次请求"变成 6 次。
          const url = signed.get(locator)
            ?? (retry >= 3 ? await resolveSignedUrl(BUCKET, locator).catch(() => null) : null)
          if (!url) { stillPending = true; continue }
          const out = await fetchAndDecryptImage(url, key)
          if (!out) { stillPending = true; continue }
          const objUrl = URL.createObjectURL(new Blob([out.bytes], { type: mimeOf(out.bytes) }))
          remember(locator, objUrl)
          if (!cancelled) setVersion((v) => v + 1)
        } catch { stillPending = true }
      }
      // 有界重试（1s / 3s / 8s）：网络抖一下、或后台正在"原地补加密"时正好取图，都能自愈
      if (!cancelled && stillPending && retry < 3) {
        const wait = [1000, 3000, 8000][retry] ?? 8000
        setTimeout(() => { if (!cancelled) setRetry((r) => r + 1) }, wait)
      }
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
