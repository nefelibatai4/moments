// 密文本地缓存（IndexedDB）
//
// 为什么要有它（2026-10-18，流量账单逼出来的）：
//   加密媒体解密后只放在**内存**里（`urlCache`），所以**每次打开/刷新页面，每张图都重新
//   从 Storage 下载一遍**。29 MB 的素材被反复拉几十次就是 23 GB 出站流量 ——
//   免费额度只有 5 GB，直接超标。
//   这里把**密文**（不是明文）落到本机，重复打开就是 0 字节。
//
// 几个刻意的取舍：
//   · 只存**密文**：设备丢了/多人共用的浏览器里，缓存里也没有可读内容；要看还得有钥匙。
//   · 键是"对象路径"：同一张图无论在动态、灯箱还是私聊里，都命中同一份。
//   · **写入即失效**：任何原地覆盖同一个路径的写入（补加密、换图）都要 `dropRaw`，
//     否则会一直显示旧内容。
//   · 有总容量上限（默认 80 MB，LRU 淘汰），不会把手机空间吃光。
//   · IndexedDB 不可用（隐私模式/被禁用）时**静默降级**，功能照旧、只是没省流量。

const DB_NAME = 'moments-media-cipher-v1'
const STORE = 'raw'

// 两个独立的池子（2026-10-22）：图片和视频分开算预算。
// 以前共用一个 80 MB 的池子 —— 一段 50 MB 的视频进来会把所有图片挤出去，
// 下次看图又要全量重下（等于把刚省下的流量又花出去）。
export const DEFAULT_LIMITS = {
  imageBytes: 150 * 1024 * 1024,
  videoBytes: 200 * 1024 * 1024,
  // 超过这个大小的对象算"视频池"（视频、大附件），避免挤占图片
  videoThreshold: 6 * 1024 * 1024,
}

let limits = { ...DEFAULT_LIMITS }

/** 只在验收脚本里用：把额度调小，才能在小内存下验证淘汰行为 */
export function setCacheLimits(next = {}) {
  limits = { ...limits, ...next }
  return limits
}

export function cacheLimits() {
  return { ...limits }
}

let dbPromise = null
let unavailable = false
// 内存里记"键 → 字节数"，按池分开，用于各自的 LRU 淘汰
const sizes = { image: new Map(), video: new Map() }

const poolOf = (bytes) => (bytes >= limits.videoThreshold ? 'video' : 'image')
const poolMax = (pool) => (pool === 'video' ? limits.videoBytes : limits.imageBytes)

function openDb() {
  if (unavailable || typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      let req
      try {
        req = indexedDB.open(DB_NAME, 1)
      } catch {
        unavailable = true
        resolve(null)
        return
      }
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'path' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => { unavailable = true; resolve(null) }
      req.onblocked = () => { unavailable = true; resolve(null) }
    })
  }
  return dbPromise
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE)
}

/**
 * 取一份缓存的密文；没有就返回 null（**永不抛出**——缓存坏了不该影响显示）
 * @returns {Promise<Uint8Array|null>}
 */
export async function getRaw(path) {
  if (!path) return null
  try {
    const db = await openDb()
    if (!db) return null
    const row = await new Promise((resolve) => {
      const req = tx(db, 'readonly').get(path)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => resolve(null)
    })
    if (!row?.bytes) return null
    // 读取时顺手更新"最近使用"（LRU 用）：先删再插，Map 的插入顺序就是最近使用顺序
    const pool = row.pool === 'video' || row.pool === 'image' ? row.pool : poolOf(row.bytes.byteLength)
    for (const p of ['image', 'video']) sizes[p].delete(path)
    sizes[pool].set(path, row.bytes.byteLength)
    return new Uint8Array(row.bytes)
  } catch {
    return null
  }
}

/** 存一份密文（不抛出；超容量时淘汰最久没用的） */
export async function putRaw(path, bytes) {
  if (!path || !bytes?.byteLength) return false
  try {
    const db = await openDb()
    if (!db) return false
    const pool = poolOf(bytes.byteLength)
    await new Promise((resolve) => {
      const req = tx(db, 'readwrite').put({ path, bytes: bytes.buffer.slice(0), at: Date.now(), pool })
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
    })
    for (const p of ['image', 'video']) sizes[p].delete(path)
    sizes[pool].set(path, bytes.byteLength)
    await trim(db, pool)
    return true
  } catch {
    return false
  }
}

/** 原地覆盖了同一个对象 → 立刻作废（下次显示会重新下载） */
export async function dropRaw(path) {
  if (!path) return
  sizes.image.delete(path)
  sizes.video.delete(path)
  try {
    const db = await openDb()
    if (!db) return
    await new Promise((resolve) => {
      const req = tx(db, 'readwrite').delete(path)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
    })
  } catch {
    /* 忽略 */
  }
}

/** 退出登录 / 换账号时清空（密文也是使用者的数据，不该留着） */
export async function clearRawCache() {
  sizes.image.clear()
  sizes.video.clear()
  try {
    const db = await openDb()
    if (!db) return
    await new Promise((resolve) => {
      const req = tx(db, 'readwrite').clear()
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
    })
  } catch {
    /* 忽略 */
  }
}

/**
 * 只淘汰指定池子里的东西 —— 视频再大也不会把图片挤出去。
 * 淘汰到 90% 以下就停（留一点余量，避免每写一条都要淘汰）。
 */
async function trim(db, pool) {
  const map = sizes[pool]
  const max = poolMax(pool)
  let total = 0
  for (const n of map.values()) total += n
  if (total <= max) return
  for (const k of [...map.keys()]) {
    if (total <= max * 0.9) break
    map.delete(k)
    total -= (await sizeOf(db, k)) ?? 0
    await new Promise((resolve) => {
      const req = tx(db, 'readwrite').delete(k)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
    })
  }
}

async function sizeOf(db, path) {
  const row = await new Promise((resolve) => {
    const req = tx(db, 'readonly').get(path)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => resolve(null)
  })
  return row?.bytes?.byteLength ?? null
}

/** 诊断用：缓存了多少条、多少字节（按池分开） */
export async function cacheStats() {
  const db = await openDb()
  if (!db) return { available: false, items: 0, bytes: 0, image: { items: 0, bytes: 0 }, video: { items: 0, bytes: 0 } }
  const rows = await new Promise((resolve) => {
    const req = tx(db, 'readonly').getAll()
    req.onsuccess = () => resolve(req.result ?? [])
    req.onerror = () => resolve([])
  })
  let bytes = 0
  const per = { image: { items: 0, bytes: 0 }, video: { items: 0, bytes: 0 } }
  for (const r of rows) {
    const n = r?.bytes?.byteLength ?? 0
    bytes += n
    const pool = r?.pool === 'video' || r?.pool === 'image' ? r.pool : poolOf(n)
    per[pool].items += 1
    per[pool].bytes += n
  }
  return { available: true, items: rows.length, bytes, ...per }
}
