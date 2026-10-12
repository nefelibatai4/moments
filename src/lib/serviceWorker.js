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

  const register = () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((err) => console.warn('[sw] 注册失败（不影响使用）:', err?.message || err))
  }

  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}
