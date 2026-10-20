import { useEffect, useMemo, useRef, useState } from 'react'
import { SPLASH_HOLD_MS, SPLASH_SPLIT, SPLASH_SUB, SPLASH_TEXT, markSplashSeen } from '../lib/splash'

// 开屏动画：暖白底 + 一条细横线先展开，字再逐字浮上来，停一下，整屏淡出。
//
// 排版口径：中文用宋体（Songti SC / Noto Serif SC 兜底），字距放宽到 0.14em ——
// 这类"欢迎回家"的句子用无衬线会显得像提示条，用衬线才有"门口"的感觉。
// 字体全部走系统字体，不下载任何字体文件（开屏不能等网络）。

const STAGGER_MS = 90

export default function SplashScreen({ onDone }) {
  const [leaving, setLeaving] = useState(false)
  const timers = useRef([])

  const reduced = useMemo(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [])

  const lines = useMemo(() => {
    if (!SPLASH_SPLIT) return [SPLASH_TEXT]
    const cut = Math.max(1, Math.floor(SPLASH_TEXT.length / 2))
    return [SPLASH_TEXT.slice(0, cut), SPLASH_TEXT.slice(cut)]
  }, [])

  // 逐字：每个字一个 span，靠 CSS 的 animation-delay 错开
  const chars = useMemo(() => {
    const out = []
    let index = 0
    lines.forEach((line, lineIdx) => {
      const row = []
      for (const ch of Array.from(line)) {
        row.push({ ch, delay: index * STAGGER_MS })
        index += 1
      }
      out.push(row)
      if (lineIdx === lines.length - 1) index += 1
    })
    return out
  }, [lines])

  useEffect(() => {
    markSplashSeen()
    const hold = reduced ? 900 : SPLASH_HOLD_MS
    timers.current.push(setTimeout(() => setLeaving(true), hold))
    timers.current.push(setTimeout(() => onDone?.(), hold + (reduced ? 200 : 620)))
    return () => timers.current.forEach(clearTimeout)
  }, [onDone, reduced])

  const skip = () => {
    if (leaving) return
    setLeaving(true)
    timers.current.forEach(clearTimeout)
    timers.current.push(setTimeout(() => onDone?.(), 220))
  }

  return (
    <div
      className={`splash-screen${leaving ? ' is-leaving' : ''}${reduced ? ' is-reduced' : ''}`}
      data-splash
      data-splash-leaving={leaving ? '1' : '0'}
      data-splash-reduced={reduced ? '1' : '0'}
      onClick={skip}
      onKeyDown={skip}
      role="presentation"
    >
      <div className="splash-inner">
        <span className="splash-rule" aria-hidden="true" />
        <h1 className="splash-title" data-splash-text>
          {chars.map((row, rowIdx) => (
            <span className="splash-line" key={rowIdx}>
              {row.map((item, i) => (
                <span
                  className="splash-char"
                  key={i}
                  style={{ animationDelay: `${item.delay}ms` }}
                >
                  {item.ch}
                </span>
              ))}
            </span>
          ))}
        </h1>
        {SPLASH_SUB ? <p className="splash-sub">{SPLASH_SUB}</p> : null}
      </div>
    </div>
  )
}
