/**
 * Service Worker 注册（待办 #6）。
 *
 * 以前只有 `subscribeToPush()` 里才注册 —— 也就是**只有开了通知的人**才有 SW，
 * 外壳缓存等于没覆盖到人。现在应用启动就注册：SW 干两件事
 * （外壳缓存见 public/sw.js 顶部说明；推送是登录后再订阅）。
 *
 * 几个刻意的取舍：
 *   * 等 `load` 之后再注册：不和应用首屏抢带宽，注册失败也绝不影响功能。
 *   * 原生 App（Capacitor）里没有 SW，注册会失败 —— 静默忽略即可。
 *   * 只在 https / localhost 下有效（浏览器限制），失败同样是静默忽略。
 */
export function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

  // ⚠️ 2026-10-29：**插件面板里不注册 SW，并顺手注销旧的**。
  //    面板是嵌在别人网页里的 iframe，SW 又会把外壳缓存起来 —— 结果是我这边改完、
  //    使用者在面板里看到的还是旧版本（"怎么又不稳定了"的一大半来源）。
  //    面板不需要离线能力（就一小块浮层），永远拿最新的最省事。
  const surface = (() => {
    try {
      const v = new URLSearchParams(window.location.search).get('surface')
      return v === 'glass' || v === 'panel' ? v : null
    } catch {
      return null
    }
  })()
  if (surface) {
    navigator.serviceWorker.getRegistrations?.()
      .then((regs) => Promise.all(regs.map((r) => r.unregister().catch(() => false))))
      .then(() => { if (typeof caches !== 'undefined') return caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))) })
      .catch(() => {})
    return
  }

  const register = () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((err) => console.warn('[sw] 注册失败（不影响使用）:', err?.message || err))
  }

  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}
