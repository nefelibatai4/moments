// Moments Web Push Service Worker
// 职责：① 应用外壳缓存（2026-09-30 新增，待办 #6）② 接收推送 → 弹桌面通知；点击通知 → 打开对应页面

/* ════════════════════════════════════════════════════════════════════════
   ① 应用外壳缓存
   ────────────────────────────────────────────────────────────────────────
   为什么：以前这个文件只处理 push，**没有任何 fetch 缓存** —— 每次冷启动都要重新
   向 GitHub Pages 取 HTML + 130KB gzip 的 JS，只靠浏览器 HTTP 缓存兜 10 分钟
   （`cache-control: max-age=600`）。插件面板每打开一次就等于加载一次网页，
   所以这个开销会被放大。装上外壳缓存后：**hashed 资源永不重下、HTML 走网络优先**。

   策略（三条，刻意保持简单）：
     1. 导航请求（HTML）：**网络优先**，失败（离线）回落到缓存。
        ⚠️ 必须网络优先：外壳一旦发旧，会影响撤回、编辑、实时这些"要立刻见效"的功能。
     2. `/assets/…-<hash>.js|css|woff2`：**缓存优先**。文件名带内容哈希，内容变了名字就变，
        所以缓存它们永远不会发旧代码。
     3. 其余同源 GET（favicon / manifest / 图标）：stale-while-revalidate（先用缓存、后台更新）。

   刻意**不**缓存的东西：
     - 任何跨域请求（Supabase 的 REST/Auth/Storage 一律不碰 —— 数据必须永远实时，
       而且带签名的图片地址每次都不一样，缓存它们只会白占空间）
     - 非 GET 请求、`sw.js` 自己、以及非 200 的响应

   版本与更新：
     - 构建时由 vite.config.js 的插件把 `__SW_VERSION__` 换成当次构建的入口哈希
       （开发服务器下保持占位符，也能正常跑）。
     - **不调用 skipWaiting**：新版本等"所有标签页关闭"后再接管。这样老页面继续用
       自己的老缓存，不会出现"页面是旧的、它要的旧 chunk 已经被清掉"的 404。
       因为 HTML 走网络优先，用户下一次打开就是新的，不需要强制刷新。
     - activate 时删掉旧版本的外壳缓存（那时已经没有老页面在用了）。
   ════════════════════════════════════════════════════════════════════════ */

const SW_VERSION = '__SW_VERSION__'
const SHELL_CACHE_PREFIX = 'moments-shell-'
const SHELL_CACHE = `${SHELL_CACHE_PREFIX}${SW_VERSION}`

// 首屏之外的小文件：装 SW 时就顺手放进来（离线打开也有图标/清单）。
// 只有这几个是"名字固定"的；带 hash 的 JS/CSS 不预缓存 —— 它们的名字每次构建都变。
const PRECACHE = ['favicon.svg', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']

/** 带内容哈希的资源：命中就永不重下 */
const HASHED_ASSET = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|svg|jpg|jpeg|webp)$/i

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(SHELL_CACHE)
        const scope = self.registration.scope
        await Promise.all(
          PRECACHE.map((f) => cache.add(new Request(new URL(f, scope).href, { cache: 'reload' })).catch(() => {})),
        )
      } catch (e) {
        // 预缓存失败绝不能挡住 SW 安装（否则连推送都没了）
        console.warn('[SW] precache failed:', e)
      }
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((n) => n.startsWith(SHELL_CACHE_PREFIX) && n !== SHELL_CACHE)
          .map((n) => caches.delete(n)),
      )
      await self.clients.claim()
    })(),
  )
})

/**
 * 存一份响应。
 * ⚠️ 导航请求要连 **404** 一起存：GitHub Pages 上 /moments/xxx 这种 SPA 深链返回的是
 *    `404.html`（状态码 404、内容是应用外壳）。只存 200 的话，离线打开深链（比如
 *    /moments/login）会直接 ERR_FAILED —— 线上实测踩到过。
 */
async function putInCache(request, response, { allow404 = false } = {}) {
  if (!response || response.type === 'opaque') return
  if (response.status !== 200 && !(allow404 && response.status === 404)) return
  try {
    const cache = await caches.open(SHELL_CACHE)
    await cache.put(request, response.clone())
  } catch {
    /* 存不下就算了：缓存永远不该影响功能 */
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  let url
  try {
    url = new URL(req.url)
  } catch {
    return
  }
  // ① 跨域一律不碰（Supabase 等）
  if (url.origin !== self.location.origin) return
  // ② 不缓存 SW 自己（否则就永远更新不了）
  if (url.pathname.endsWith('/sw.js')) return

  const isNavigate = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')

  // ── 策略 1：HTML 网络优先 ──
  if (isNavigate) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req)
          await putInCache(req, fresh, { allow404: true })
          return fresh
        } catch {
          // 离线：回落到缓存。ignoreSearch 让 ?surface=panel 之类的参数也能命中
          const cached = await caches.match(req, { ignoreSearch: true })
          return cached || Response.error()
        }
      })(),
    )
    return
  }

  // ── 策略 2：带 hash 的资源缓存优先 ──
  if (HASHED_ASSET.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req)
        if (cached) return cached
        const fresh = await fetch(req)
        await putInCache(req, fresh)
        return fresh
      })(),
    )
    return
  }

  // ── 策略 3：其余同源 GET：先用缓存、后台更新 ──
  event.respondWith(
    (async () => {
      const cached = await caches.match(req)
      const network = fetch(req)
        .then(async (fresh) => {
          await putInCache(req, fresh)
          return fresh
        })
        .catch(() => null)
      return cached || (await network) || Response.error()
    })(),
  )
})


// Push 事件：收到推送时弹桌面通知
self.addEventListener('push', (event) => {
  // ⚠️ 解密失败或载荷为空时，event.data 会是 null。
  //    这里以前是直接 `return` —— 结果是**永远没有弹窗、也没有任何报错**，
  //    2026-09 那次"推送完全不工作"就是这样被藏了很久（详见 docs/PITFALLS.md #48）。
  //    现在至少弹一条兜底通知：出问题要看得见，而不是静默消失。
  if (!event.data) {
    const scope = self.registration.scope
    event.waitUntil(
      self.registration.showNotification('Moments 私密圈', {
        body: '有新内容（这条推送没有携带正文，可能是载荷异常）',
        icon: new URL('favicon.svg', scope).href,
        badge: new URL('favicon.svg', scope).href,
        tag: 'moments-no-payload',
        data: { url: scope }
      })
    )
    return
  }

  try {
    const payload = event.data.json()
    const { title, body, icon, url, tag } = payload
    const scope = self.registration.scope

    const options = {
      body,
      icon: icon || new URL('favicon.svg', scope).href,
      badge: new URL('favicon.svg', scope).href,
      tag: tag || 'moments',
      data: { url: url || scope },
      requireInteraction: false,
      vibrate: [200, 100, 200]
    }

    event.waitUntil(self.registration.showNotification(title, options))
  } catch (e) {
    console.error('[SW] push parse error:', e)
  }
})

// 点击通知时打开对应页面
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const scope = self.registration.scope
  const targetUrl = event.notification.data?.url || scope

  event.waitUntil(
    (async () => {
      // 复用已打开的本站窗口。注意必须先 navigate 到通知里的目标地址：
      // 旧实现在这里只 focus，导致点"新私聊消息"只切到标签页、停在原页面，
      // 通知携带的 /moments/chat/<id> 被丢掉了。
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })

      for (const client of clientList) {
        let sameOrigin = false
        try {
          sameOrigin = new URL(client.url).origin === new URL(scope).origin
        } catch {
          sameOrigin = false
        }
        if (!sameOrigin) continue

        if ('navigate' in client) {
          try {
            const navigated = await client.navigate(targetUrl)
            return (navigated || client).focus()
          } catch (e) {
            console.error('[SW] navigate failed:', e)
          }
        }
        if ('focus' in client) return client.focus()
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl)
      }
    })()
  )
})