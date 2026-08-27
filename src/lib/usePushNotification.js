// Moments Web Push 订阅管理
// 职责：注册 Service Worker → 请求通知权限 → 获取 PushSubscription → 保存到后端

const VAPID_PUBLIC_KEY = 'BD2LhxvJUdv6qW67k1GZAA2k5FudUaNvErhE7m_7yyKmoiVruYerrMCiVMnpD_zhK6UsXFRGbMrAwO2u0KYlJv4'

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)))
}

/**
 * 注册 Service Worker 并订阅推送。
 * 调用时机：用户登录后，在 App 顶层调用一次即可。
 */
export async function subscribeToPush(supabase, session) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[push] browser does not support Web Push')
    return false
  }

  try {
    // 1. 注册 Service Worker（BASE_URL 由 vite.config.js 的 base 决定，即 /moments/）
    const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
    await navigator.serviceWorker.ready

    // 2. 检查是否已有订阅，没有才请求权限并订阅
    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        console.warn('[push] notification permission denied')
        return false
      }
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      })
    }

    // 3. 保存到数据库（upsert，重复登录不产生重复记录）
    const sub = subscription.toJSON()
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        {
          user_id: session.user.id,
          endpoint: sub.endpoint,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth
        },
        { onConflict: 'user_id,endpoint' }
      )
    if (error) throw error

    console.log('[push] subscribed successfully')
    return true
  } catch (e) {
    console.error('[push] subscribe error:', e)
    return false
  }
}

/**
 * 取消推送订阅（用户登出时调用）
 */
export async function unsubscribeFromPush(supabase) {
  if (!('serviceWorker' in navigator)) return

  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (subscription) {
      const endpoint = subscription.endpoint
      await subscription.unsubscribe()
      await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
      console.log('[push] unsubscribed')
    }
  } catch (e) {
    console.error('[push] unsubscribe error:', e)
  }
}