const KEY = 'moments_theme'

/**
 * ⚠️ 每一次 localStorage 访问都必须包在 try/catch 里。
 *
 * 为什么（2026-09-23 实测）：网页可能跑在**第三方 iframe** 里（浏览器插件的面板就是），
 * 而第三方上下文里的存储可能被拦 —— 一旦被拦，`localStorage` 的**属性访问本身**就抛
 * SecurityError。而 `initTheme()` 是 main.jsx 里的第一条语句，它一抛，
 * **整个应用都挂不上去**（`#root` 里什么都没有）→ 面板表现为一片空白。
 * 实测复现：把 localStorage 换成"一访问就抛"之后，面板里 `#root` 子节点数 = 0。
 *
 * 所以：主题读不到就用默认深色，写不进去就算了，**永远不要让它阻断启动**。
 */
function readStoredTheme() {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

export function getTheme() {
  return readStoredTheme() || 'dark'
}

export function setTheme(theme) {
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // 存不进去不影响这次会话的外观（属性照样设上）
  }
  document.documentElement.setAttribute('data-theme', theme)
  // 广播"使用者主动改了主题"。面板帧里的 content.js 只认这一类主动修改
  // （它的 data-theme 也可能只是扩展下发下来的副本，不该被当成使用者的意见上报）
  try {
    window.postMessage({ source: 'moments-app', type: 'theme-change', theme }, '*')
  } catch {
    /* 忽略 */
  }
}

/** 只应用外观、不写存储：用于扩展把"全局主题"递进来的场景（见 lib/extensionBridge.js） */
export function applyTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') return
  document.documentElement.setAttribute('data-theme', theme)
}

export function initTheme() {
  document.documentElement.setAttribute('data-theme', getTheme())
}
