import { useEffect, useState } from 'react'
import { loadStickers } from '../lib/stickers'

/**
 * 表情面板。
 *
 * ⚠️ **不常驻**：只有点开时才挂载、才去取清单（使用者的性能标准：常驻的 9.5MB JS 堆被他否掉过）。
 * 面板里的缩略图统一用**静态首帧**（一格一格播 32 个雪碧图会白白烧 CPU），
 * 真正播放留给消息里的那个 —— 那是"看着舒服"的地方，列表里不需要。
 */
export default function StickerPicker({ onPick, onClose }) {
  const [pack, setPack] = useState(null)

  useEffect(() => {
    let cancelled = false
    loadStickers().then((res) => { if (!cancelled) setPack(res) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="sticker-picker" role="dialog" aria-label="表情">
      <div className="sticker-picker-head">
        <span>表情</span>
        <button type="button" className="sticker-picker-close" onClick={onClose} aria-label="收起表情">×</button>
      </div>
      {!pack && <p className="status-text">加载中…</p>}
      {pack && (
        <div className="sticker-grid">
          {pack.items.map((it) => (
            <button
              key={it.id}
              type="button"
              className="sticker-grid-item"
              title={it.label}
              aria-label={it.label}
              onClick={() => onPick?.(it.id)}
            >
              <img src={it.posterSrc} alt="" width={48} height={48} loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
