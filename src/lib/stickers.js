/**
 * 表情包（使用者 2026-10-14）。
 *
 * ── 设计要点 ────────────────────────────────────────────────────
 *  · 表情包是**应用资产**（`public/stickers/`，来自微软 MIT 的动画 Fluent Emoji，见该目录下的
 *    LICENSE 声明），不是用户数据 → **不上传、不加密、离线可用、秒开**。
 *  · 消息里只传一个 **id**：正文就是 `[[s:<id>]]` 这一小段文本，走原本的端到端加密 →
 *    服务器连"你发了哪个表情"都看不到（比 Telegram 更强）。
 *  · 播放用**雪碧图 + CSS `steps()`**：零 JS 每帧、GPU 合成、能随时暂停（离屏/切后台/减少动效）。
 *    动画 PNG 本身没法暂停，所以生成脚本把它转成了"雪碧图 + 静态首帧"。
 *  · 认不出来的 id（比如以后删了某个表情）→ 退化成文字，绝不显示空白。
 */
const BASE = import.meta.env.BASE_URL || '/'
const MANIFEST_URL = `${BASE}stickers/manifest.json`

/** 一条消息的正文如果整段就是它，那这条消息是"表情" */
const STICKER_RE = /^\[\[s:([a-z0-9_]+)\]\]$/

let cached = null
let inflight = null

export function stickerIdFromContent(text) {
  if (typeof text !== 'string') return null
  const m = text.match(STICKER_RE)
  return m ? m[1] : null
}

export function stickerContent(id) {
  return `[[s:${id}]]`
}

/** 加载清单（只请求一次；失败返回 null，调用方照常降级为文字） */
export async function loadStickers() {
  if (cached) return cached
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch(MANIFEST_URL, { cache: 'force-cache' })
      if (!res.ok) return null
      const data = await res.json()
      // 给每项补上可直接用的地址（雪碧图 + 静态首帧）
      const items = (Array.isArray(data?.items) ? data.items : []).map((it) => ({
        ...it,
        cell: it.cell ?? data?.cell ?? 120,
        sheetSrc: `${BASE}stickers/${it.sheet}`,
        posterSrc: `${BASE}stickers/${it.poster}`,
      }))
      const byId = new Map(items.map((it) => [it.id, it]))
      cached = { cell: data?.cell ?? 120, items, byId }
      return cached
    } catch {
      return null
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** 已经加载好的清单（同步；没加载好返回 null） */
export function stickersSync() {
  return cached
}
