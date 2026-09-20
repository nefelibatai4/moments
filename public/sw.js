// Moments Web Push Service Worker
// 职责：接收推送 → 弹桌面通知；点击通知 → 打开对应页面

// Push 事件：收到推送时弹桌面通知
self.addEventListener('push', (event) => {
  if (!event.data) return

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