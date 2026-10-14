import { useEffect, useState } from 'react'
import { loadStickers } from '../lib/stickers'
import Sticker from './Sticker'

/**
 * 消息里的一个表情。清单还没加载好时先占位（保持尺寸、不跳动），
 * 认不出来的 id 退化成一句文字 —— 绝不显示空白。
 */
export default function StickerMessage({ id, size = 120 }) {
  const [item, setItem] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadStickers().then((pack) => {
      if (cancelled) return
      const found = pack?.byId?.get(id) ?? null
      if (found) setItem(found)
      else setFailed(true)
    })
    return () => { cancelled = true }
  }, [id])

  if (failed) return <span className="chat-sticker-fallback">[表情]</span>
  if (!item) return <span className="sticker sticker-placeholder" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true" />
  return <Sticker item={item} size={size} />
}
