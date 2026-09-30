import { useEffect, useState } from 'react'

/**
 * 隐藏的"手机视口自检面板"。
 *
 * ── 为什么需要它（使用者 2026-09-30 的实际问题）
 * 手机上底栏"浮空"、键盘弹起时输入框"飞到最上面"，但在 Mac 的 Chrome 里、
 * 甚至在 iOS **模拟器的 Capacitor App 里**都复现不出来。使用者用的是
 * Safari「添加到主屏幕」的**独立网页模式**（standalone），它的视口语义
 * 与 App 内的 WKWebView 不同 —— 而 AI 拿不到真机的数字，只能猜。
 * 有了这个面板，使用者打开 App 连点标题 5 次截个图，就能把真值交回来。
 *
 * 开启方式（两种，都刻意不做成可见入口）：
 *   1. URL 带 `?debug=1`（电脑上用）
 *   2. 在 App 里 3 秒内连点顶部标题（h1）5 次 —— 手机上不用输网址也能开
 * 关闭：再连点 5 次，或点面板右上角的 ×。
 *
 * ⚠️ 它只读数值、不写任何状态，也不上报；线上留着不影响正常使用。
 */
export default function ViewportDebug() {
  const [open, setOpen] = useState(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === '1'
  )
  const [, setTick] = useState(0)

  // 连点标题 5 次（3 秒内）也能开 —— 手机上没法敲 ?debug=1
  useEffect(() => {
    let taps = []
    const onClick = (e) => {
      const h1 = document.querySelector('.app-header h1')
      if (!h1 || !h1.contains(e.target)) return
      const now = Date.now()
      taps = taps.filter((t) => now - t < 3000)
      taps.push(now)
      if (taps.length >= 5) {
        taps = []
        setOpen((v) => !v)
      }
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  // 打开时跟着视口变化刷新数字（键盘弹起/收起都能看到实时值）
  useEffect(() => {
    if (!open) return
    const bump = () => setTick((t) => t + 1)
    const vv = window.visualViewport
    vv?.addEventListener('resize', bump)
    vv?.addEventListener('scroll', bump)
    window.addEventListener('resize', bump)
    const id = setInterval(bump, 500)
    return () => {
      vv?.removeEventListener('resize', bump)
      vv?.removeEventListener('scroll', bump)
      window.removeEventListener('resize', bump)
      clearInterval(id)
    }
  }, [open])

  if (!open) return null

  const vv = window.visualViewport
  const doc = document.documentElement
  const cs = getComputedStyle(doc)
  const r = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return '—'
    const b = el.getBoundingClientRect()
    return `${Math.round(b.top)}~${Math.round(b.bottom)} (h${Math.round(b.height)})`
  }
  const standalone =
    (typeof navigator !== 'undefined' && navigator.standalone) ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)

  const rows = [
    `screen      ${screen.width}×${screen.height}  dpr ${devicePixelRatio}`,
    `innerWH     ${window.innerWidth}×${window.innerHeight}`,
    `visualView  ${vv ? Math.round(vv.width) + '×' + Math.round(vv.height) : '—'}`,
    `vv.offsetTop ${vv ? Math.round(vv.offsetTop) : '—'}   pageTop ${vv ? Math.round(vv.pageTop) : '—'}`,
    `键盘占掉    ${vv ? window.innerHeight - Math.round(vv.height) : '—'}`,
    `scrollY     ${Math.round(window.scrollY)}`,
    `--app-h     ${cs.getPropertyValue('--app-h').trim() || '(空)'}`,
    `--safe-top  ${cs.getPropertyValue('--safe-top').trim()}   --safe-bottom ${cs.getPropertyValue('--safe-bottom').trim()}`,
    `--tabbar-h  ${cs.getPropertyValue('--tabbar-h').trim() || '(空)'}`,
    `body        ${r('body')}  overflow ${getComputedStyle(document.body).overflow}`,
    `html height ${getComputedStyle(doc).height}  overflow ${getComputedStyle(doc).overflow}`,
    `.app-cont   ${r('.app-container')}`,
    `main        ${r('main')}`,
    `.app-header ${r('.app-header')}`,
    `底栏离底    ${(() => { const el = document.querySelector('.app-header'); return el ? Math.round(window.innerHeight - el.getBoundingClientRect().bottom) + 'px' : '—' })()}`,
    `standalone  ${standalone ? '是' : '否'}   surface ${doc.getAttribute('data-surface') || '(无)'}`,
  ]

  return (
    <div className="viewport-debug" role="dialog" aria-label="视口自检">
      <button type="button" className="viewport-debug-close" aria-label="关闭" onClick={() => setOpen(false)}>×</button>
      <div className="viewport-debug-title">视口自检（连点标题 5 次开关）</div>
      <pre>{rows.join('\n')}</pre>
    </div>
  )
}
