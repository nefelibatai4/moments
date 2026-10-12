import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabaseClient'

/**
 * 私有桶的图片地址（2026-09-30 起：`moment-images` / `avatars` 都改成 public = false）。
 *
 * ── 为什么 ──────────────────────────────────────────────────────
 * 桶以前是公开的：只要拿到 URL，**任何人（包括完全匿名、没有账号的人）都能永久访问**，
 * 而且 `avatars` 桶还允许匿名列举用户 UUID。现在读图必须先换一个**带签名的临时地址**，
 * 过期就失效；没登录/没激活的人连签都签不出来。
 *
 * ── 怎么用 ──────────────────────────────────────────────────────
 * 数据库里仍然存"定位串"（就是以前 getPublicUrl 拼出来的那个地址，见 objectLocator），
 * 它**本身已经不可访问**，只用来提取对象路径。渲染时统一走：
 *   - 组件：`<SignedImage bucket="avatars" stored={profile.avatar_url} />`
 *   - 一批：`const urls = useSignedUrls(moment.images, 'moment-images')`
 *
 * ── 两个工程细节 ─────────────────────────────────────────────────
 * 1. **同一个 tick 里的请求会合并**成一次 `createSignedUrls`（一屏 9 张图 = 1 个请求，
 *    而不是 9 个）。因为签名要走网络，逐张签会让信息流明显变慢。
 * 2. **内存缓存**：签名地址默认 1 小时有效，缓存里提前 5 分钟就重新签，
 *    所以正常的翻页/重渲染不会再打网络。缓存只在内存里（刷新即失效）。
 */

/** 签名有效期（秒）。越短越安全（泄漏的链接更快失效），越长越不容易在长时间停留的页面上裂图 */
export const SIGNED_URL_TTL_SECONDS = 3600

// 提前这么久就当作"该重签了"，避免正好卡在过期那一瞬间
const RENEW_MARGIN_MS = 5 * 60 * 1000

/** `${bucket}/${path}` → { url, expiresAt } */
const cache = new Map()
/** 待签队列：bucket → { paths:Set, waiters:[] } */
const queue = new Map()
let flushTimer = null

/**
 * 从任何形态的地址里取出 storage 里的**对象路径**。
 * 兼容：公开地址（/object/public/…）、已签名地址（/object/sign/…?token=…）、裸路径。
 * ⚠️ 用在删除对象上（remove）时必须是裸路径，不能带 query。
 */
export function storagePathFromUrl(stored) {
  if (!stored || typeof stored !== 'string') return null
  // ⚠️ 必须先把"带协议但不是 http(s)"的挡掉：`data:`（测试里的 1px gif）、`blob:` 之类
  //    以前会被当成"裸路径"，于是拿它去请求签名 → 报错 → 图片永远不显示。
  if (/^[a-z][a-z0-9+.-]*:/i.test(stored) && !/^https?:\/\//i.test(stored)) return null
  if (!/^https?:\/\//i.test(stored)) return stored.replace(/^\/+/, '') || null
  try {
    const { pathname } = new URL(stored)
    const m = pathname.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/[^/]+\/(.+)$/)
    return m ? decodeURIComponent(m[1]) : null
  } catch {
    return null
  }
}

/**
 * 存库用的"定位串"：保持与老的 getPublicUrl 完全同形，**不改变已有数据的形态**。
 * 它本身不可直接访问（桶已私有），只是路径的载体 —— 渲染一律走签名。
 */
export function objectLocator(bucket, path) {
  const base = import.meta.env.VITE_SUPABASE_URL
  return `${base}/storage/v1/object/public/${bucket}/${path}`
}

function keyOf(bucket, path) {
  return `${bucket}/${path}`
}

/** 同步取缓存（里没有或快过期就返回 null）—— 用来避免"先空一下再闪出图片" */
export function peekSignedUrl(bucket, stored) {
  const path = storagePathFromUrl(stored)
  if (!path) return null
  const hit = cache.get(keyOf(bucket, path))
  if (!hit) return null
  if (hit.expiresAt - Date.now() < RENEW_MARGIN_MS) return null
  return hit.url
}

/** 申请一个签名地址（同 tick 的多个申请会被合并） */
export function requestSignedUrl(bucket, stored) {
  const path = storagePathFromUrl(stored)
  if (!path) return Promise.resolve(null)
  const peeked = peekSignedUrl(bucket, stored)
  if (peeked) return Promise.resolve(peeked)

  return new Promise((resolve) => {
    let item = queue.get(bucket)
    if (!item) {
      item = { paths: new Set(), waiters: [] }
      queue.set(bucket, item)
    }
    item.paths.add(path)
    item.waiters.push({ path, resolve })
    if (!flushTimer) flushTimer = setTimeout(flushQueue, 0)
  })
}

async function flushQueue() {
  flushTimer = null
  const batches = Array.from(queue.entries())
  queue.clear()

  for (const [bucket, item] of batches) {
    const paths = Array.from(item.paths)
    let rows = []
    try {
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
      if (!error && Array.isArray(data)) rows = data
    } catch {
      rows = []   // 网络失败：当作"这批没签出来"，调用方渲染占位，不裂图也不抛
    }
    const byPath = new Map(rows.map((r) => [r.path, r.signedUrl]))
    const expiresAt = Date.now() + SIGNED_URL_TTL_SECONDS * 1000
    for (const waiter of item.waiters) {
      const url = byPath.get(waiter.path) || null
      if (url) cache.set(keyOf(bucket, waiter.path), { url, expiresAt })
      waiter.resolve(url)
    }
  }
}

/**
 * 让某个对象的缓存失效（换头像这类"同一个路径、内容变了"的场景必须调）。
 * 不失效的话：路径没变 → 缓存里还是老签名地址 → 浏览器/CDN 拿老地址命中老图，
 * 表现就是"换了头像但看起来没换"。
 */
export function invalidateSignedUrl(bucket, stored) {
  const path = storagePathFromUrl(stored)
  if (path) cache.delete(keyOf(bucket, path))
}

/** 测试用：清空内存缓存与队列 */
export function __resetSignedUrlCache() {
  cache.clear()
  queue.clear()
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
}

/** 不是桶里的地址（外链、data:、favicon 之类）原样返回：这类图片不需要签名 */
function isStorageRef(stored) {
  return !!storagePathFromUrl(stored)
}

function snapshot(bucket, list) {
  const map = new Map()
  for (const stored of list) {
    if (!isStorageRef(stored)) { map.set(stored, stored); continue }
    const url = peekSignedUrl(bucket, stored)
    if (url) map.set(stored, url)
  }
  return map
}

/**
 * 点开大图/下载时用：**不管签名有没有就绪都能拿到地址**。
 * 为什么需要它：签名要走一次网络，如果只在"签名回来之后"才允许点开，
 * 手快的人点第一下会没反应（测试里表现为点不开灯箱）。
 */
export async function resolveSignedUrl(bucket, stored) {
  if (!stored) return null
  if (!isStorageRef(stored)) return stored
  return peekSignedUrl(bucket, stored) ?? requestSignedUrl(bucket, stored)
}

/**
 * 一批图片的签名地址：返回 `Map<原始串, 签名地址>`。
 * 没签出来的不在 Map 里（调用方自己决定占位）。
 */
export function useSignedUrls(list, bucket) {
  const stored = (list ?? []).filter(Boolean)
  const joinKey = stored.join('|')
  const [map, setMap] = useState(() => snapshot(bucket, stored))

  useEffect(() => {
    let cancelled = false
    const missing = stored.filter((s) => isStorageRef(s) && !peekSignedUrl(bucket, s))
    if (missing.length === 0) return undefined
    ;(async () => {
      const pairs = await Promise.all(
        missing.map(async (s) => [s, await requestSignedUrl(bucket, s)]),
      )
      if (cancelled) return
      setMap((prev) => {
        const next = new Map(prev)
        for (const [s, url] of pairs) if (url) next.set(s, url)
        return next
      })
    })()
    return () => { cancelled = true }
    // joinKey 是 stored 的内容指纹：内容没变就不重复签
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinKey, bucket])

  // ⚠️ 渲染期兜底：**不是桶里的地址**（外链、data:、favicon）原样返回。
  //    不能只在 useState 初始化时处理 —— 聊天页那种"先空列表、后追加消息"的场景，
  //    后加进来的外链图会不在 map 里，界面就永远不显示（踩过一次）。
  return useMemo(() => {
    const merged = new Map(map)
    for (const stored of list ?? []) if (stored && !storagePathFromUrl(stored)) merged.set(stored, stored)
    return merged
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, joinKey])
}

/** 单个图片的签名地址（内部走同一套缓存与批处理） */
export function useSignedUrl(stored, bucket) {
  const map = useSignedUrls(stored ? [stored] : [], bucket)
  return map.get(stored) ?? null
}
