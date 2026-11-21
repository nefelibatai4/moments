/**
 * 版本自检的「不打断」提示条。
 *
 * 背景：以前 main.jsx 读到 version.json 与当前构建不一致就立即 `location.reload()`。
 * Pages 的 HTML 有 10 分钟缓存，插件面板又经常被反复打开，所以用户会看到
 * 「加载 → 闪一下 → 又从头加载」的二次加载闪烁，正在输入/浏览的内容也会被打断。
 *
 * 现在的策略：
 *   * 发现新版本时**只弹一条提示**，当前页面继续用，不 reload、不阻塞任何操作；
 *   * 用户点「立即刷新」才真正换壳；
 *   * 点「稍后」收起提示，本次会话不再为同一个构建重复弹。
 *
 * 为什么「不刷新」也不会长期停在旧壳：public/sw.js 对导航请求是**网络优先**，
 * 用户下一次自然打开 / 刷新页面时就会拿到新 HTML 和新的 hash 资源。本提示只是
 * 给想立刻升级的人一个入口，不是版本生效的唯一途径。
 */

const DISMISSED_KEY = 'moments_update_dismissed_build'
const NOTICE_ATTR = 'data-update-notice'

function sessionGet(key) {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function sessionSet(key, value) {
  try {
    sessionStorage.setItem(key, value)
  } catch { /* 隐私模式/存储被禁：不影响刷新入口 */ }
}

/**
 * 启动时读一次 version.json；发现当前壳不是最新构建就弹提示。
 * 失败/离线/没有构建号时静默跳过（和原来的自检一样，不影响功能）。
 *
 * @param {string|null} currentBuild 当前页面编译时的构建号（__APP_BUILD__）
 */
export function checkForUpdate(currentBuild) {
  if (!currentBuild || currentBuild === 'dev') return
  if (typeof document === 'undefined') return

  try {
    const url = `${import.meta.env.BASE_URL}version.json?cb=${Date.now()}`
    fetch(url, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const latest = j && j.build
        if (!latest || latest === currentBuild) return
        if (sessionGet(DISMISSED_KEY) === latest) return
        showUpdateNotice(latest)
      })
      .catch(() => {})
  } catch { /* 忽略 */ }
}

/**
 * 把提示条挂到 body 上。固定定位、不参与布局，所以不会改变任何页面的几何，
 * 也不会碰首屏底色（见 index.html 的 html:not([data-surface="glass"]) 规则）。
 */
export function showUpdateNotice(latestBuild) {
  if (typeof document === 'undefined') return
  if (document.querySelector(`[${NOTICE_ATTR}]`)) return

  const mount = () => {
    if (document.querySelector(`[${NOTICE_ATTR}]`)) return

    const bar = document.createElement('div')
    bar.className = 'update-notice'
    bar.setAttribute(NOTICE_ATTR, '')
    bar.setAttribute('role', 'status')
    bar.setAttribute('aria-live', 'polite')
    bar.dataset.updateBuild = latestBuild

    const text = document.createElement('span')
    text.className = 'update-notice-text'
    text.textContent = '有新版本可用，刷新后生效'

    const actions = document.createElement('span')
    actions.className = 'update-notice-actions'

    const reload = document.createElement('button')
    reload.type = 'button'
    reload.className = 'update-notice-btn update-notice-btn-primary'
    reload.dataset.updateAction = 'reload'
    reload.textContent = '立即刷新'
    reload.addEventListener('click', () => {
      // 唯一的刷新点：由用户点击触发，不再在版本检出时自动整页重载。
      window.location.reload()
    })

    const later = document.createElement('button')
    later.type = 'button'
    later.className = 'update-notice-btn'
    later.dataset.updateAction = 'dismiss'
    later.textContent = '稍后'
    later.addEventListener('click', () => {
      sessionSet(DISMISSED_KEY, latestBuild)
      bar.remove()
    })

    actions.append(reload, later)
    bar.append(text, actions)
    document.body.appendChild(bar)
  }

  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
}
