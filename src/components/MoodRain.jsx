import { useEffect, useRef, useState } from 'react'

/**
 * 动态卡片上的「下雨」层（使用者 2026-10-14：发布时选心情，参考苹果天气的效果）。
 *
 * ── 画的是什么 ──────────────────────────────────────────────────
 * 苹果天气的雨观感可以拆成四层，这里依次画（全部是 canvas 2D，零依赖）：
 *   ① 远处的细密雨丝（慢、淡、细）
 *   ② 中景雨丝（略快、略亮）
 *   ③ 近处的大雨滴（快、亮、粗，带轻微拖尾）
 *   ④ 落到下缘的**涟漪**（一小圈扩散的弧）+ 一点点薄雾
 * 深色冷调的底由 CSS 叠一层渐变（见 .mood-rain-backdrop），canvas 只管雨 —— 这样切换/重绘更便宜。
 *
 * ── ⚠️ 做不到的事（诚实记录）────────────────────────────────────
 * 苹果天气那种"雨滴打在玻璃上、把背后的内容折射得扭曲"需要把背景渲染进 canvas。
 * 卡片内容是 DOM，canvas 采不到它（除非把整张卡画进 canvas，代价大、还会打死文字选中与交互）。
 * 所以卡片里只能做"半透明雨层叠加"；要真正的沉浸感，得放到整页背景或灯箱那一层。
 *
 * ── 开销护栏（使用者的性能标准很硬：曾因 9.5MB JS 堆否掉常驻面板）────
 *   · **只在卡片可见时**才跑：IntersectionObserver（阈值 0.35）+ document.visibilitychange
 *   · **同屏最多 MAX_ANIMATING 张卡在跑**，超出的显示静态帧（9 张卡各跑一条 rAF 是不能接受的）
 *   · `prefers-reduced-motion: reduce` → 只画一帧静态（有雨，但完全不动）
 *   · DPR 上限 2、粒子总量上限、帧间隔下限（≈60fps 封顶，不为高刷屏空转）
 *   · 卸载/离屏立刻 cancelAnimationFrame 并归还名额（不留后台动画）
 *
 * 测试用的 DOM 契约（与 `data-signed` 同一套思路，方便断言"是不是真的在动"）：
 *   `data-mood-rain="1"`、`data-rain-mode="animating" | "static"`、`data-rain-reduced="1"`（系统要求减少动效时）
 *   ⚠️ 类名**不能**叫 `.mood-rain`：卡片的修饰类就是 `moment-card mood-rain`，
 *      两者同名时"雨层不吃事件"那条 `pointer-events: none` 会同时命中整张卡片
 *      —— 症状是下雨卡片点赞/评论**完全点不动**（2026-10-14 使用者报的，见 PITFALLS #99）。
 */
const MAX_ANIMATING = 3
const MAX_DROPS = 220
const MIN_FRAME_MS = 1000 / 60

/** 当前有几张卡正在跑（模块级；不是为了性能统计，而是为了"同屏最多几张"这条硬约束） */
let animatingCount = 0

function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

export default function MoodRain() {
  const canvasRef = useRef(null)
  const [mode, setMode] = useState('static')

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof canvas.getContext !== 'function') return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    const staticOnly = prefersReducedMotion()
    let w = 0
    let h = 0
    let dpr = 1
    let drops = []
    let splashes = []
    let raf = 0
    let lastTs = 0
    let running = false
    let holdingSlot = false
    let visible = false
    let stopped = false
    let retryTimer = 0

    /** 按画布宽度铺雨：远/中/近三层，各有各的速度、粗细、透明度 */
    function build() {
      const far = Math.round(Math.min(MAX_DROPS * 0.45, w * 0.34))
      const mid = Math.round(Math.min(MAX_DROPS * 0.3, w * 0.2))
      const near = Math.round(Math.min(MAX_DROPS * 0.12, w * 0.07))
      const layer = (n, cfg) => Array.from({ length: n }, () => ({
        x: Math.random() * (w + 60) - 30,
        y: Math.random() * h,
        len: cfg.len[0] + Math.random() * (cfg.len[1] - cfg.len[0]),
        v: cfg.v[0] + Math.random() * (cfg.v[1] - cfg.v[0]),
        a: cfg.a[0] + Math.random() * (cfg.a[1] - cfg.a[0]),
        lw: cfg.lw,
        ripple: cfg.ripple,
      }))
      drops = [
        ...layer(far, { len: [7, 14], v: [420, 620], a: [0.1, 0.22], lw: 1, ripple: false }),
        ...layer(mid, { len: [12, 22], v: [640, 900], a: [0.18, 0.34], lw: 1.2, ripple: false }),
        ...layer(near, { len: [18, 34], v: [900, 1250], a: [0.3, 0.5], lw: 1.8, ripple: true }),
      ]
    }

    function resize() {
      const rect = canvas.getBoundingClientRect()
      const nextW = Math.max(1, Math.round(rect.width))
      const nextH = Math.max(1, Math.round(rect.height))
      dpr = Math.min(2, window.devicePixelRatio || 1)
      if (nextW === w && nextH === h) return
      w = nextW
      h = nextH
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      build()
      drawStatic()
    }

    /** 画一帧（dt=0 表示"只画这一帧、不动"，用于静态模式与首帧） */
    function paint(dt) {
      ctx.clearRect(0, 0, w, h)
      // 风：慢慢摆动的横向偏移，让雨不是死板的斜线
      const wind = Math.sin(performance.now() / 5200) * 0.16 + 0.18

      for (const d of drops) {
        if (dt > 0) {
          d.y += d.v * dt
          d.x += d.v * dt * wind
          if (d.y - d.len > h) {
            if (d.ripple && splashes.length < 14) {
              splashes.push({ x: d.x, y: h - 1, r: 1, a: 0.5 })
            }
            d.y = -d.len - Math.random() * 40
            d.x = Math.random() * (w + 60) - 30
          }
          if (d.x > w + 40) d.x = -30
        }
        ctx.strokeStyle = `rgba(196, 224, 246, ${d.a})`
        ctx.lineWidth = d.lw
        ctx.beginPath()
        ctx.moveTo(d.x, d.y - d.len)
        ctx.lineTo(d.x - d.len * wind * 0.5, d.y)
        ctx.stroke()
      }

      // 涟漪：扩散 + 变淡，很短命
      if (splashes.length > 0) {
        const alive = []
        for (const s of splashes) {
          if (dt > 0) {
            s.r += 26 * dt
            s.a -= 1.5 * dt
          }
          if (s.a > 0.02 && s.r < 14) {
            ctx.strokeStyle = `rgba(206, 232, 250, ${Math.max(0, s.a)})`
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.ellipse(s.x, s.y, s.r, s.r * 0.42, 0, 0, Math.PI * 2)
            ctx.stroke()
            alive.push(s)
          }
        }
        splashes = alive
      }
    }

    function drawStatic() {
      paint(0)
      setMode('static')
    }

    function loop(ts) {
      if (stopped || !running) return
      if (ts - lastTs >= MIN_FRAME_MS - 1) {
        const dt = Math.min(0.05, (ts - (lastTs || ts - 16)) / 1000)
        lastTs = ts
        paint(dt)
      }
      raf = requestAnimationFrame(loop)
    }

    function start() {
      if (stopped || running) return
      if (staticOnly) { drawStatic(); return }
      if (animatingCount >= MAX_ANIMATING) {
        // 名额满了（同屏太多张卡）：先画静态帧，过一会儿再试试 —— 别的卡滚走后就能轮到自己
        drawStatic()
        if (!retryTimer) {
          retryTimer = setTimeout(() => { retryTimer = 0; if (visible && !document.hidden) start() }, 1500)
        }
        return
      }
      running = true
      holdingSlot = true
      animatingCount += 1
      setMode('animating')
      lastTs = 0
      raf = requestAnimationFrame(loop)
    }

    function stop() {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      if (running) {
        running = false
        setMode('static')
      }
      if (holdingSlot) {
        holdingSlot = false
        animatingCount = Math.max(0, animatingCount - 1)
      }
    }

    const io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
        visible = !!entries[0]?.isIntersecting
        if (visible && !document.hidden) start()
        else { stop(); drawStatic() }
      }, { threshold: 0.35 })
      : null

    function onVisibility() {
      if (document.hidden) { stop(); drawStatic(); return }
      if (visible) start()
    }

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null

    resize()
    if (io) io.observe(canvas)
    else visible = true                                   // 没有 IntersectionObserver：就当作可见
    document.addEventListener('visibilitychange', onVisibility)
    ro?.observe(canvas)
    if (visible && !document.hidden) start()

    return () => {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      stop()
      io?.disconnect()
      ro?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="mood-rain-canvas"
      data-mood-rain="1"
      data-rain-mode={mode}
      {...(prefersReducedMotion() ? { 'data-rain-reduced': '1' } : {})}
      aria-hidden="true"
    />
  )
}
