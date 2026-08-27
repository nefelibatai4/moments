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

  const url = event.notification.data?.url || self.registration.scope
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('/moments/') && 'focus' in client) {
          return client.focus()
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url)
      }
    })
  )
})