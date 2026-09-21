// 把网页里已经登录的会话同步给扩展，这样扩展不需要你再登录一次。
//
// 为什么这么做：扩展的源是 chrome-extension://，和 https://nefelibatai4.github.io
// 是两个不同的源，读不到对方 localStorage。但 content script 是跑在网页这一侧的，
// 它的 localStorage 就是网页自己的——所以能直接把会话读出来交给 background。
//
// all_frames: true 是必需的：popup 面板里是用 iframe 嵌的网页，
// 那个 iframe 里的会话也要能同步出来。
//
// 这个脚本不需要知道 anon key，只需要知道 supabase 存会话用的那个 key 名。
;(() => {
  // supabase-js v2 的 key 规则：sb-<项目ref>-auth-token
  // 项目 ref 就是 supabase 域名去掉 .supabase.co
  const PROJECT_REF = 'pshscdqhhsktrpzkbmei'
  const KEY = `sb-${PROJECT_REF}-auth-token`

  let lastPushed = null

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
    try {
      const p = chrome.runtime.sendMessage({ type: 'session:push', session: parsed })
      // 扩展被重载时 background 可能还没醒，发送会失败——下一次轮询会补上
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {
      /* 扩展上下文失效（例如刚重载），忽略 */
    }
  }

  push()

  // 登录/登出不会触发 storage 事件（storage 事件只在*其他*标签页触发），
  // 所以这里用一个低频轮询兜住本标签页内的变化。读一个 localStorage key 很便宜。
  setInterval(push, 10000)

  // 其他标签页里登录/登出时，storage 事件会触发，立刻同步
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key === KEY || e.key.startsWith(`${KEY}.`)) push()
  })

  // 从别的应用切回来时也补一次
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') push()
  })
})()
