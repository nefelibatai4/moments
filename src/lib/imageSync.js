import { supabase } from '../supabaseClient'
import { conversationKey, momentKey } from './crypto'
import { decryptImageBytes, encryptImageBytes } from './imageCrypto'
import { resolveSignedUrl, storagePathFromUrl } from './signedUrls'

/**
 * 历史明文图片的"补加密"（阶段 3 的收尾，2026-10-13）。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────
 * 加密只对**新上传**的图片生效；桶里已经躺着的图片还是明文（整张图谁都能看）。
 * 要真正做到"服务器看不到内容"，这些老图也得在**使用者的设备上**换成密文。
 *
 * ── 怎么判断一张图是不是已经加密了 ──────────────────────────────
 * 不用加数据库列，也不靠文件名：直接把字节拿来**试着解开**
 *   · 解出来是图片且 `encrypted=true` → 已经是密文，跳过（**不会重复加密**）；
 *   · 解出来是图片且 `encrypted=false` → 老明文图 → 加密后**原地覆盖**（路径不变，
 *     所有引用照旧有效，也不需要改任何数据库行）；
 *   · 解不开 → 拿不到钥匙或格式不认识 → 跳过（下次再说）。
 * 代价是每次会话会对自己的图片各做一次"下载+尝试解密"（都走 Service Worker 缓存，
 * 命中时只是一次本地读取 + 毫秒级 AES），换来的是**不需要任何新字段**。
 *
 * ── 覆盖的权限 ──────────────────────────────────────────────────
 * 桶的策略只允许"覆盖自己目录下的对象"（`moment_images_owner_update`），而这里处理的
 * 全是**自己发的**动态与消息里的图，所以权限天然对得上。别人发的图得对方打开时补。
 */

const MAX_IMAGES_PER_RUN = 40
/**
 * 只处理"足够老"的内容（默认 60 秒）。
 *
 * 为什么（2026-10-15 实测踩到）：补加密是**原地覆盖**对象。刚上传的图片可能
 *   ① 发布流程还没走完（正要写数据库行）；② 对方/自己正在读它。
 * 于是会出现"读到的字节一半是新的"这种竞态（读路径有重试兜底，但不该制造它）。
 * 历史数据本来就是几小时/几天前的，晚一分钟处理没有任何损失。
 */
const MIN_AGE_MS = 60 * 1000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tooFresh = (createdAt) => {
  const t = createdAt ? Date.parse(createdAt) : 0
  return !!t && Date.now() - t < MIN_AGE_MS
}

let running = false

export async function sweepImagePlaintext(me) {
  if (running || !me) return { moments: 0, messages: 0 }
  running = true
  let moments = 0
  let messages = 0
  try {
    // ① 自己动态里的图（钥匙是那条动态的 CEK）
    const { data: myMoments } = await supabase
      .from('moments')
      .select('id, images, created_at')
      .eq('user_id', me)
      .not('images', 'is', null)
      .order('created_at', { ascending: false })
      .limit(10)
    for (const m of myMoments ?? []) {
      if (moments >= MAX_IMAGES_PER_RUN) break
      if (tooFresh(m.created_at)) continue      // 刚发的先不动（见 MIN_AGE_MS 的说明）
      const cek = await momentKey(m.id, me)
      if (!cek) continue        // 还没生成 CEK（正文扫尾还没跑到）→ 下次再说
      for (const locator of m.images ?? []) {
        if (moments >= MAX_IMAGES_PER_RUN) break
        if (await sealOne(locator, cek)) moments += 1
      }
    }

    // ② 自己发出去的私聊图（钥匙是那段会话的会话密钥）
    const { data: myMsgs } = await supabase
      .from('messages')
      .select('id, image_url, recipient_id, created_at')
      .eq('sender_id', me)
      .not('image_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(20)
    const keyCache = new Map()
    for (const msg of myMsgs ?? []) {
      if (messages >= MAX_IMAGES_PER_RUN) break
      if (tooFresh(msg.created_at)) continue    // 同上
      if (!keyCache.has(msg.recipient_id)) {
        keyCache.set(msg.recipient_id, await conversationKey(msg.recipient_id).catch(() => null))
      }
      const ck = keyCache.get(msg.recipient_id)
      if (!ck) continue
      if (await sealOne(msg.image_url, ck)) messages += 1
    }
  } catch (err) {
    console.warn('[image] 补加密中断:', err?.message)
  } finally {
    running = false
    if (moments || messages) console.info(`[image] 本次补加密 动态图 ${moments} · 私聊图 ${messages}`)
  }
  return { moments, messages }
}

/** 一张图：已加密就跳过，是明文就原地换成密文；返回 true 表示"这次真的补了一张" */
async function sealOne(locator, key) {
  const path = storagePathFromUrl(locator)
  if (!path || !key) return false
  try {
    const url = await resolveSignedUrl('moment-images', locator)
    if (!url) return false
    const res = await fetch(url, { credentials: 'omit' })
    if (!res.ok) return false
    const raw = new Uint8Array(await res.arrayBuffer())
    const probe = await decryptImageBytes(key, raw)
    if (!probe || probe.encrypted) return false       // 已经加密 / 认不出来 → 不动它
    const sealed = await encryptImageBytes(key, probe.bytes)
    const { error } = await supabase.storage
      .from('moment-images')
      .upload(path, new Blob([sealed], { type: 'application/octet-stream' }), {
        contentType: 'application/octet-stream',
        upsert: true,
      })
    if (error) {
      console.warn('[image] 覆盖成密文失败:', error.message)
      return false
    }
    return true
  } catch (err) {
    console.warn('[image] 单张补加密失败:', err?.message)
    return false
  } finally {
    await sleep(80)      // 别把带宽打满（一次会话就几十张）
  }
}
