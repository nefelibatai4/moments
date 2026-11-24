/**
 * 「这个页面跑在哪种外壳里」——电脑浏览器整页 / 插件毛玻璃浮层 / 插件兜底小窗。
 *
 * ── 为什么要区分 ────────────────────────────────────────────────
 * 同一个网站在三个位置的合理呈现并不一样（就像同一个网站在手机和电脑上不一样）：
 *   · 整页（电脑浏览器）：现在这套（留给刘海/指示条的安全区、宽松的导航、下载入口…）
 *   · 毛玻璃浮层：面板只有 **上方的 1/4 屏**、宽 420px，而且**整页背景必须透明**，
 *     否则网页自己的底色会把浮层的毛玻璃整个盖住（＝毛玻璃"完全没生效"）。
 *   · 兜底小窗：同样是窄面板，要紧凑，但窗口是不透明的，所以底色照旧。
 *
 * ── 标记怎么传进来的 ────────────────────────────────────────────
 * 扩展在 iframe 地址上带 `?surface=glass` / `?surface=panel`（见 extension/overlay.js
 * 与 extension/panel.html）。app 内跳转是前端路由、**不重新加载文档**，
 * 所以启动时在 <html> 上打一次 `data-surface` 就够用了；
 * 同时写进 sessionStorage，让 iframe 万一被整页重载也能记住（同一标签页内有效）。
 *
 * ⚠️ 只认白名单里的两个值：这个参数只影响样式，别人的页面想给我们的 iframe 加上它
 *    也无所谓（改不了行为，只会让面板看起来更透）。但绝不能拿它当权限判断用。
 */

const KEY = 'moments_surface'
const VALID = ['glass', 'panel']

export function initSurface() {
  let value = null
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('surface')
    if (VALID.includes(fromUrl)) {
      value = fromUrl
      sessionStorage.setItem(KEY, fromUrl)
    } else {
      const saved = sessionStorage.getItem(KEY)
      if (VALID.includes(saved)) value = saved
    }
  } catch {
    // 极端情况（storage 被禁用）下退化成"整页形态"，不影响功能
  }
  // ⚠️ 2026-11-24 使用者反馈："为什么网页版改成这样了" —— 他把插件的**兜底小窗**最大化/拉宽了，
  //    而 `?surface=panel` 是**无条件**套紧凑排版的（去掉了桌面左侧竖栏、按 420 宽设计），
  //    于是一个 1426px 宽的窗口里出现"没有竖栏 + 窄列"的怪样子。
  //    面板形态只在**窄**的时候才合理：宽屏下退回整页形态（外面那层浮层的样式由扩展自己负责，
  //    这里只影响网页自己的排版）。阈值 900：浮层 420、小窗默认 420 都远小于它。
  if (value && window.innerWidth >= 900) {
    document.documentElement.removeAttribute('data-surface')
    value = null
  }
  if (value) document.documentElement.setAttribute('data-surface', value)
}

export function getSurface() {
  try {
    return document.documentElement.getAttribute('data-surface')
  } catch {
    return null
  }
}

/** 当前是否跑在插件的面板外壳里（浮层 / 兜底小窗）——与整页行为不同的地方用它判断 */
export function isPanelSurface() {
  try {
    const v = document.documentElement.getAttribute('data-surface')
    return v === 'glass' || v === 'panel'
  } catch {
    return false
  }
}
