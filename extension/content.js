// 网页 → 扩展的桥：会话同步 + 面板背景设置中继。
//
// 为什么需要它：扩展的源是 chrome-extension://，和 https://nefelibatai4.github.io
// 是两个不同的源，读不到对方 localStorage（反之亦然）。而 content script 是跑在
// 网页这一侧的，它的 localStorage 就是网页自己的。
//
// all_frames: true 是必需的，两个地方都靠它：
//   ① 面板（浮层 / 兜底小窗）里是用 iframe 嵌的网页，那个 iframe 里的会话也要同步出来；
//   ② 浮层要靠 iframe 里的这个脚本报一句 `panel:frameReady`，
//      才知道"面板真的加载出来了"，而不是被宿主网页的 CSP 挡住了。
//
// 这个脚本不需要知道 anon key，只需要知道 supabase 存会话用的那个 key 名。
;(() => {
  // supabase-js v2 的 key 规则：sb-<项目ref>-auth-token
  // 项目 ref 就是 supabase 域名去掉 .supabase.co
  const PROJECT_REF = 'pshscdqhhsktrpzkbmei'
  const KEY = `sb-${PROJECT_REF}-auth-token`
  // 与 src/lib/panelBackground.js 的 PANEL_BG_KEY 必须一致
  const PANEL_BG_KEY = 'moments_panel_bg'

  let lastPushed = null

  // ---------------------------------------------------------------- 会话同步

  // supabase-js 在会话较大时会分片存储成 key.0 / key.1 …，所以两种都要能读
  function readRaw() {
    try {
      const whole = localStorage.getItem(KEY)
      if (whole) return whole

      const parts = []
      for (let i = 0; i < 20; i += 1) {
        const part = localStorage.getItem(`${KEY}.${i}`)
        if (!part) break
        parts.push(part)
      }
      return parts.length ? parts.join('') : null
    } catch {
      // 某些页面上下文里访问 localStorage 会抛（例如被策略禁用），忽略即可
      return null
    }
  }

  function send(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg)
      // 扩展被重载时 background 可能还没醒，发送会失败——下一次轮询会补上
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {
      /* 扩展上下文失效（例如刚重载），忽略 */
    }
  }

  function push() {
    const raw = readRaw()
    // 只在真正变化时才发，避免每 10 秒无谓地打扰 background
    if (!raw || raw === lastPushed) return

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!parsed || !parsed.access_token) return

    lastPushed = raw
    send({ type: 'session:push', session: parsed })
  }

  // ---------------------------------------------------------------- 面板背景设置

  function readPanelBg() {
    try {
      const raw = localStorage.getItem(PANEL_BG_KEY)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }

  // ⚠️ 只上报"用户显式设过的主题"。
  //
  // 为什么（2026-09-23 实测踩到）：面板里的 iframe 会拿到**默认**主题（深色），
  // 如果它把 documentElement 上的当前值直接上报，就会把使用者真正的选择（浅色）
  // 覆盖掉 —— 于是"扩展递下去的浅色"和"面板上报上来的深色"互相打架，
  // 面板最终显示的还是深色。
  // 判据：localStorage 里**有** moments_theme 才说明是显式设置过的；
  // 没有就是默认值，不该当成用户的意见往外报。
  function readTheme() {
    try {
      if (!localStorage.getItem('moments_theme')) return null
      return document.documentElement.getAttribute('data-theme') || null
    } catch {
      return null
    }
  }

  let lastPanelSent = null

  function pushPanelSettings() {
    const settings = readPanelBg()
    const theme = readTheme()
    const shape = JSON.stringify({ settings, theme })
    // 变化才发（这个函数会被 postMessage / storage / 10 秒轮询 / 属性观察反复触发）
    if (shape === lastPanelSent) return
    lastPanelSent = shape
    send({ type: 'panel:settings', settings, theme })
  }

  // ---------------------------------------------------------------- 触发时机

  push()
  pushPanelSettings()

  // 登录/登出、主题切换都不会触发 storage 事件（storage 事件只在*其他*标签页触发），
  // 所以这里用一个低频轮询兜住本标签页内的变化。读两个 localStorage key 很便宜。
  setInterval(() => {
    push()
    pushPanelSettings()
    pushGlobalState()
  }, 10000)

  // 其他标签页里登录/登出/改设置时，storage 事件会触发，立刻同步
  window.addEventListener('storage', (e) => {
    if (!e.key) return
    if (e.key === KEY || e.key.startsWith(`${KEY}.`)) push()
    if (e.key === PANEL_BG_KEY) pushPanelSettings()
  })

  // 【我】里改设置时网页会 postMessage 广播（见 src/lib/panelBackground.js）。
  // ⚠️ 必须校验 `event.source === window`：面板浮层把本站嵌在**任意网页**里，
  //    而宿主网页可以往这个 iframe 里 postMessage 伪造一条设置消息。
  //    只认"本文档自己发的"就把它挡在外面了。
  window.addEventListener('message', (e) => {
    if (e.source !== window) return
    const data = e.data
    if (!data || data.source !== 'moments-app' || data.type !== 'panel-bg') return
    pushPanelSettings()
  })

  // 主题是挂在 <html data-theme> 上的，改主题不会触发上面任何一条 → 观察属性。
  try {
    new MutationObserver(pushPanelSettings).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
  } catch {
    /* 极老的浏览器没有 MutationObserver，靠 10 秒轮询兜住 */
  }

  // 从别的应用切回来时也补一次
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      push()
      pushPanelSettings()
    }
  })

  // ---------------------------------------------------------------- 面板 → 网页的状态下发

  // 在面板里（浮层 / 兜底小窗的 iframe）时，把扩展手里的会话、主题、面板背景交给网页。
  // 为什么：这一层 iframe 是**第三方上下文**，它的 localStorage 可能读不到、读到的是另一份，
  // 甚至一访问就抛异常 —— 那样面板就会显示成"没登录 / 主题不对"（使用者 2026-09-23 报的
  // "不同主页点开插件，样子和登录状态都不一样"）。扩展手里本来就有一份，直接递过去最省事。
  //
  // ⚠️ 网页那边（src/lib/extensionBridge.js）会校验 `event.source === window`，
  //    所以宿主网页伪造的消息进不来；这里发的消息也**只发到本文档自己**（不是 parent）。
  const isPanelFrame = window.top !== window
  let lastStateSent = null

  function pushGlobalState(force) {
    if (!isPanelFrame) return
    try {
      chrome.runtime.sendMessage({ type: 'state:get' }, (res) => {
        if (!res) return
        const shape = JSON.stringify([Boolean(res.session), res.theme, res.panelBg])
        if (!force && shape === lastStateSent) return
        lastStateSent = shape
        try {
          window.postMessage({ source: 'moments-ext', type: 'state', ...res }, '*')
        } catch { /* 忽略 */ }
      })
    } catch { /* 扩展上下文失效，忽略 */ }
  }

  pushGlobalState(true)

  // 网页那边有可能比我们晚注册监听（打包产物是后加载的），它主动要的时候再发一次。
  // ⚠️ 同样只认本文档自己发的消息。
  window.addEventListener('message', (e) => {
    if (e.source !== window) return
    if (e.data && e.data.source === 'moments-app' && e.data.type === 'state-request') {
      pushGlobalState(true)
    }
  })

  // 扩展里的会话/主题变了（例如在别的标签页里登录了）→ 再下发一次
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      if (changes.session || changes.panelTheme || changes.panelBg) pushGlobalState(true)
    })
  } catch { /* 忽略 */ }

  // 告诉扩展"这个页面（可能是浮层里的 iframe）已经加载好了"。
  // 浮层等不到这句话就认为网页被宿主页面的 CSP 挡住 → 退回独立小窗。
  if (window.top !== window) send({ type: 'panel:frameReady' })
})()
