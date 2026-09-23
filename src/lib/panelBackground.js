/**
 * 扩展面板（毛玻璃浮层）的背景设置。
 *
 * ── 为什么设置存在网页这边，而不是扩展里 ──────────────────────────
 * 使用者 2026-09-22 明确要求：开关放【我】里，不要放在扩展里。
 * 而扩展的面板又是用 iframe 嵌的网页，所以**网页的 localStorage 天然就是
 * 这个设置的唯一存放处** —— 面板里的 iframe、普通标签页、扩展浮层读到的都是
 * 同一份（浮层自己读不到，由 content script 转交，见 extension/content.js）。
 *
 * ── 设置项（三项，刻意不做颜色选择器）────────────────────────────
 *   mode: 'glass' 毛玻璃（浮层半透明 + 模糊背后的网页）| 'solid' 纯色
 *   tint: 'theme' 跟随【我】的深/浅色主题 | 'dark' | 'light'
 *   blur: 0–30，模糊程度（只在 glass 下生效；0 = 只是染色，网页完全清晰）
 *
 * 纯色模式下 tint 的语义变成"面板底色"（不透明），这也是"背景颜色切换"这句话的落点。
 */

export const PANEL_BG_KEY = 'moments_panel_bg'

export const PANEL_BG_DEFAULTS = {
  mode: 'glass',
  tint: 'theme',
  // 12px 是"看得出是毛玻璃、但背后内容依然能辨认"的位置
  blur: 12,
}

export function getPanelBg() {
  try {
    const raw = localStorage.getItem(PANEL_BG_KEY)
    if (!raw) return { ...PANEL_BG_DEFAULTS }
    const parsed = JSON.parse(raw)
    return normalizePanelBg(parsed)
  } catch {
    // 坏数据（手改、旧版本残留）不该让【我】整页崩掉，回默认值
    return { ...PANEL_BG_DEFAULTS }
  }
}

export function normalizePanelBg(input) {
  const mode = input?.mode === 'solid' ? 'solid' : 'glass'
  const tint = input?.tint === 'dark' || input?.tint === 'light' ? input.tint : 'theme'
  const rawBlur = Number(input?.blur)
  const blur = Number.isFinite(rawBlur) ? Math.min(30, Math.max(0, Math.round(rawBlur))) : PANEL_BG_DEFAULTS.blur
  return { mode, tint, blur }
}

export function setPanelBg(patch) {
  const next = normalizePanelBg({ ...getPanelBg(), ...patch })
  localStorage.setItem(PANEL_BG_KEY, JSON.stringify(next))
  announcePanelBg(next)
  return next
}

/**
 * 把设置解析成实际要用的 CSS 值。
 *
 * ⚠️ **扩展侧有一份必须保持一致的副本**：`extension/overlay.js` 里的 `panelBgStyle()`。
 *    扩展没有打包器（就是几个裸文件，靠 Chrome 直接加载），import 不到这里，
 *    所以只能各写一份。防漂移靠 `scripts/verify-extension-panel.cjs` 里的等价性断言：
 *    它会比对「网页预览」与「浮层实际渲染」算出来的 backdrop-filter 是否一模一样。
 *
 * @param {{mode:'glass'|'solid', tint:'theme'|'dark'|'light', blur:number}} settings
 * @param {'dark'|'light'|undefined} theme 网页当前主题（tint 为 theme 时才有用）
 */
export function panelBgStyle(settings, theme) {
  const dark = settings.tint === 'theme' ? theme !== 'light' : settings.tint === 'dark'

  if (settings.mode === 'solid') {
    return { background: dark ? '#07080a' : '#f7f8f8', backdropFilter: 'none' }
  }

  // 0.55 是"透得出来、但文字依然清楚"的位置；saturate 让背后的网页颜色不显得灰掉
  // （数值参考 glassmorphism 的通用配方：薄亮边框 + 半透明底 + 一点饱和提升）
  return {
    background: dark ? 'rgba(10, 11, 14, 0.55)' : 'rgba(247, 248, 248, 0.58)',
    backdropFilter: `blur(${settings.blur}px) saturate(160%)`,
  }
}

/**
 * 把设置广播出去，让扩展的浮层立刻跟上（不用重开面板）。
 *
 * 两条通道，缺一不可：
 *   ① `window.postMessage` —— 页面 → content script（同文档另一个 world）。
 *      这是"改了立刻生效"的关键：扩展浮层里嵌的也是这个网页，
 *      所以在浮层里改设置也能马上看到。
 *   ② content script 收到后会转发给 background 存进 chrome.storage.local，
 *      浮层再通过 chrome.storage.onChanged 更新自己。
 *
 * ⚠️ 用 `'*'` 作为 targetOrigin：浮层可能嵌在**任意网站**的页面上，
 * 我们不知道父页面的源是什么。这里发的只是"面板好不好看"，不是敏感数据，
 * 所以可以接受（⚠️ 以后若要往这条通道里塞任何用户数据，必须先把源钉死）。
 */
export function announcePanelBg(settings = getPanelBg()) {
  try {
    window.postMessage({ source: 'moments-app', type: 'panel-bg', settings }, '*')
  } catch {
    /* 极端情况下 postMessage 不可用也不该影响设置本身已存好 */
  }
}
