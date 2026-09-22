// Moments Web Push Service Worker
// 职责：接收推送 → 弹桌面通知；点击通知 → 打开对应页面

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