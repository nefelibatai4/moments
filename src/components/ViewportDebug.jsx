import { useEffect, useState } from 'react'

/**
 * 隐藏的"手机视口自检面板"。
 *
 * ── 为什么需要它（使用者 2026-09-30 的实际问题）
 * 手机上底栏"浮空"、键盘弹起时输入框"飞到最上面"，但在 Mac 的 Chrome 里、
 * 甚至在 iOS **模拟器的 Capacitor App 里**都复现不出来。使用者用的是
 * Safari「添加到主屏幕」的**独立网页模式**（standalone），视口语义与 App 内不同 ——
 * 而 AI 拿不到真机数字就只能猜。有了这个面板，使用者双击底部「动态」截个图，
 * 真值就回来了：`standalone 是 / innerHeight 812 / --app-h 812 / 底栏离底 0`。
 *
 * 开启方式（都不是可见入口）：
 *   1. URL 带 `?debug=1`（电脑上用）
 *   2. App 里**双击**底部「动态」标题 —— 手机上不用敲网址
 * 关闭：再双击一次，或点面板右上角 ×。
 *
 * ⚠️ 面板是 `pointer-events: none`，**不挡操作**：开着它照样能进私聊、弹键盘 ——
 *    这正是量"键盘态"所需要的（第一版挡住了，使用者反馈"打开面板就打不开私聊了"）。
 *    它还自动记录**历史极值**，所以操作一遍、最后截一张图就够，不必抓拍瞬间。
 */
export default function ViewportDebug() {
  const [open, setOpen] = useState(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === '1'
  )
  const [tick, setTick] = useState(0)
  const [stats, setStats] = useState({ maxGap: 0, maxKb: 0, maxOffsetTop: 0, minAppH: 0, maxAppH: 0 })
  const [fps, setFps] = useState(null)

  // 双击底部「动态」标题（.app-header h1）
  useEffect(() => {
    let last = 0
    const onClick = (e) => {
      const h1 = document.querySelector('.app-header h1')
      if (!h1 || !h1.contains(e.target)) return
      const now = Date.now()
      if (now - last < 500) {
        last = 0
        setOpen((v) => !v)
      } else {
        last = now
      }
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  // 采样只在事件/定时器里做（⛔ 不在渲染期读写 ref —— oxlint 会报，React 也可能重放渲染）
  useEffect(() => {
    if (!open) return
    const sample = () => {
      const v = window.visualViewport
      const headerEl = document.querySelector('.app-header')
      const gap = headerEl ? Math.round(window.innerHeight - headerEl.getBoundingClientRect().bottom) : 0
      const kb = v ? window.innerHeight - Math.round(v.height) : 0
      const off = v ? Math.round(v.offsetTop) : 0
      const ah = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-h')) || 0
      setStats((s) => ({
        maxGap: Math.max(s.maxGap, gap),
        maxKb: Math.max(s.maxKb, kb),
        maxOffsetTop: Math.max(s.maxOffsetTop, off),
        minAppH: ah && (s.minAppH === 0 || ah < s.minAppH) ? ah : s.minAppH,
        maxAppH: Math.max(s.maxAppH, ah),
      }))
      setTick((t) => t + 1)
    }
    const v = window.visualViewport
    v?.addEventListener('resize', sample)
    v?.addEventListener('scroll', sample)
    window.addEventListener('resize', sample)
    const id = setInterval(sample, 500)
    return () => {
      v?.removeEventListener('resize', sample)
      v?.removeEventListener('scroll', sample)
      window.removeEventListener('resize', sample)
      clearInterval(id)
    }
  }, [open])

  // 面板打开时实测 rAF 帧率：这是"动画能跑多快"的唯一真凭据。
  // iPhone 上网页内容被系统限在 60Hz（WebKit #272165），想看真实数值就开这个面板。
  useEffect(() => {
    if (!open) return
    let raf = 0
    let last = 0
    let intervals = []
    let worst = 0
    let worstAt = 0
    const loop = (t) => {
      if (last) {
        const dt = t - last
        intervals.push(dt)
        if (intervals.length > 30) intervals.shift()
        if (dt > worst || t - worstAt > 3000) { worst = dt; worstAt = t }
      }
      last = t
      if (intervals.length >= 5) {
        const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length
        setFps({ hz: Math.round(1000 / avg), worst: Math.round(worst) })
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [open])

  if (!open) return null
  void tick // 只为触发重渲染

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
  const headerEl = document.querySelector('.app-header')
  const gapNow = headerEl ? Math.round(window.innerHeight - headerEl.getBoundingClientRect().bottom) : null

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
    `底栏离底    ${gapNow === null ? '—' : gapNow + 'px'}`,
    `standalone  ${standalone ? '是' : '否'}   surface ${doc.getAttribute('data-surface') || '(无)'}`,
    `rAF 帧率 ≈ ${fps ? fps.hz + ' fps' : '测量中…'}（最近最慢一帧 ${fps ? fps.worst : '—'}ms）`,
    `—— 历史极值（从打开面板起）——`,
    `底栏离底最大 ${stats.maxGap}px   键盘最高 ${stats.maxKb}px   offsetTop 最大 ${stats.maxOffsetTop}px`,
    `--app-h 区间 ${Math.round(stats.minAppH)}~${Math.round(stats.maxAppH)}px`,
  ]

  return (
    <div className="viewport-debug" role="dialog" aria-label="视口自检">
      <button type="button" className="viewport-debug-close" aria-label="关闭" onClick={() => setOpen(false)}>×</button>
      <div className="viewport-debug-title">视口自检（双击底部「动态」开关）</div>
      <pre>{rows.join('\n')}</pre>
    </div>
  )
}
