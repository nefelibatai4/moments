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

  // ⚠️ 2026-11-12：面板里**恢复**注册 SW。
  //    前几天为了让面板"永远拿最新版"把 SW 关掉了，代价是每次打开都要**从网络重新下整包** ——
  //    使用者反馈"点插件后黑屏时间比以前更长"。而外壳 HTML 本来就是网络优先（见 public/sw.js），
  //    版本新鲜度并不依赖关掉 SW；带 hash 的资源缓存反而让面板秒开。
  //    这里补一步"每次打开都主动检查更新"，两侧兼得。
  const surfaceEarly = (() => {
    try {
      const v = new URLSearchParams(window.location.search).get('surface')
      return v === 'glass' || v === 'panel' ? v : null
    } catch {
      return null
    }
  })()
  if (surfaceEarly) {
    try {
      navigator.serviceWorker.getRegistration?.().then((reg) => reg?.update?.()).catch(() => {})
    } catch { /* 忽略 */ }
  }

  const register = () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((err) => console.warn('[sw] 注册失败（不影响使用）:', err?.message || err))
  }

  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}
