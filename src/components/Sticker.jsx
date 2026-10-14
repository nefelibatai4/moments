import { useEffect, useRef, useState } from 'react'

/**
 * 一个表情（雪碧图 + CSS `steps()` 播放）。
 *
 * 为什么不用 `<img>` 放动画 PNG/GIF：那样**没法暂停**（离屏、切后台、系统开"减少动态效果"时
 * 都还在烧 CPU/电），而雪碧图只要去掉动画 class 就停住了。
 *
 * 开销护栏（与 MoodRain 同一套思路，使用者的性能标准是硬要求）：
 *   · 只有**可见时**才播（IntersectionObserver，阈值 0.2）
 *   · 切到后台 → `animation-play-state: paused`
 *   · `prefers-reduced-motion: reduce` → 只显示**静态首帧**，一点动画都不跑
 *   · 同一屏最多 MAX_PLAYING 个在播，其余显示静态首帧
 *
 * 测试用的 DOM 契约：`data-sticker="<id>"`、`data-sticker-mode="play" | "still"`。
 */
const MAX_PLAYING = 8
let playingCount = 0

function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

export default function Sticker({ item, size = 120, className = '' }) {
  const ref = useRef(null)
  const [mode, setMode] = useState('still')
  const still = prefersReducedMotion()

  useEffect(() => {
    if (still) { setMode('still'); return undefined }
    const el = ref.current
    if (!el) return undefined
    let visible = false
    let holding = false

    const acquire = () => {
      if (holding || playingCount >= MAX_PLAYING) return false
      holding = true
      playingCount += 1
      return true
    }
    const release = () => {
      if (!holding) return
      holding = false
      playingCount = Math.max(0, playingCount - 1)
    }
    const sync = () => {
      if (visible && !document.hidden && acquire()) setMode('play')
      else {
        if (!visible || document.hidden) release()
        setMode('still')
      }
    }

    const io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => { visible = !!entries[0]?.isIntersecting; sync() }, { threshold: 0.2 })
      : null
    if (io) io.observe(el)
    else { visible = true; sync() }
    document.addEventListener('visibilitychange', sync)
    return () => {
      io?.disconnect()
      document.removeEventListener('visibilitychange', sync)
      release()
    }
  }, [still])

  const style = {
    width: `${size}px`,
    height: `${size}px`,
    backgroundImage: `url(${item.posterSrc})`,
  }
  if (mode === 'play') {
    style.backgroundImage = `url(${item.sheetSrc})`
    style.backgroundSize = `${item.cell * item.frames}px ${item.cell}px`
    style.animation = `sticker-play ${item.durationMs}ms steps(${item.frames}) infinite`
    style['--sticker-width'] = `${item.cell * item.frames}px`
  }

  return (
    <span
      ref={ref}
      className={`sticker ${className}`}
      style={style}
      data-sticker={item.id}
      data-sticker-mode={mode}
      role="img"
      aria-label={item.label}
      title={item.label}
    />
  )
}
