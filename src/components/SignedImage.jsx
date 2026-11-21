import { useRef, useState } from 'react'
import { invalidateSignedUrl, resolveSignedUrl, storagePathFromUrl, useSignedUrl } from '../lib/signedUrls'

/** 加载失败后最多重签 2 次；再失败就显示默认头像，避免 4xx → 重签 → 4xx 的死循环。 */
const MAX_RESIGN_RETRIES = 2

/** 最终兜底：中性人像，父容器的圆形背景仍然生效；不会出现浏览器裂图图标。 */
const DEFAULT_AVATAR = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9aa0a6" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="8" r="3.4"/><path d="M5 20c.7-3.6 3.5-5.8 7-5.8s6.3 2.2 7 5.8"/></svg>',
)}`

/**
 * 私有桶里的图片（见 lib/signedUrls.js）。
 *
 * 签名要走一次网络，所以第一帧可能还没有地址 —— 这时渲染一个**没有 src 的 `<img>`**：
 * 不裂图、不弹 alt 文本，CSS 的尺寸规则（`.moment-avatar img { … }`）也照样生效，
 * 拿到地址后自动换成真图（同一个元素，不会二次布局）。
 * 测试可以看 `data-signed="1"` 判断"地址已经拿到了"。
 *
 * ⚠️ 需要"点开看大图"时不要依赖这里的解析结果：手快的人会点在解析之前。
 *    用 `resolveSignedUrl()`（按需解析，命中缓存时同步返回）。
 *
 * ⚠️ 签名只活 1 小时，页面久开时 `<img>` 可能拿到过期地址而加载失败。
 *    这时**只给这一张图**清缓存并重签（`invalidateSignedUrl` + `resolveSignedUrl`），
 *    同一 tick 里的多个失败仍会被 signedUrls 的队列合并成一次请求，不会破坏"一屏多图只签一次"。
 *    初始批量签名逻辑完全不参与，重试也有上限，不会变成死循环。
 */
export default function SignedImage({ bucket, stored, alt = '', onError, ...rest }) {
  const url = useSignedUrl(stored, bucket)
  const isStorage = !!storagePathFromUrl(stored)
  const sourceKey = `${bucket ?? ''}|${stored ?? ''}`
  // 重签结果按"桶 + 对象"记账；stored 变了就视为一张新图，旧状态不沿用。
  const [recovery, setRecovery] = useState({ key: sourceKey, url: null, attempt: 0, failed: false })
  const retryRef = useRef(null)
  const current = recovery.key === sourceKey
    ? recovery
    : { key: sourceKey, url: null, attempt: 0, failed: false }

  async function handleError(event) {
    onError?.(event)
    if (!isStorage || !stored) return
    // 引用只在事件里读写（渲染期不碰 ref），避免同一次失败并发触发多轮重签。
    if (retryRef.current?.key !== sourceKey) {
      retryRef.current = { key: sourceKey, count: 0, busy: false }
    }
    const retry = retryRef.current
    if (retry.busy) return
    if (retry.count >= MAX_RESIGN_RETRIES) {
      setRecovery({ key: sourceKey, url: null, attempt: retry.count, failed: true })
      return
    }
    retry.count += 1
    retry.busy = true
    // 先清掉旧签名，否则 resolveSignedUrl 会从缓存里把同一个过期地址拿回来。
    invalidateSignedUrl(bucket, stored)
    try {
      const fresh = await resolveSignedUrl(bucket, stored)
      setRecovery((prev) => {
        if (prev.key !== sourceKey) return prev
        return fresh
          ? { key: sourceKey, url: fresh, attempt: retry.count, failed: false }
          : { key: sourceKey, url: null, attempt: retry.count, failed: true }
      })
    } catch {
      setRecovery((prev) => (
        prev.key === sourceKey
          ? { key: sourceKey, url: null, attempt: retry.count, failed: true }
          : prev
      ))
    } finally {
      retry.busy = false
    }
  }

  if (current.failed) {
    return (
      <img
        src={DEFAULT_AVATAR}
        alt={alt}
        data-signed="0"
        data-fallback="1"
        {...rest}
      />
    )
  }

  // ⚠️ 桶里的图片要用 **CORS 请求**（crossorigin="anonymous"）：
  //    ① 这样 Service Worker 里 fetch 到的响应不是 opaque（能读到 200 状态码），
  //       才能安全地按对象路径缓存字节 —— 否则响应状态是 0，只能全部放弃缓存；
  //    ② 跨域图片的传输字节也能被性能面板/测试量到。
  //    外链（测试里的 favicon 等）不加 crossorigin：那些服务器不一定回 CORS 头，
  //    加了反而会加载失败。
  const src = current.url ?? url ?? undefined
  return (
    <img
      // 重签后即使地址碰巧没变也强制重新挂载，确保浏览器真的再试一次。
      key={`${sourceKey}#${current.attempt}`}
      src={src}
      alt={alt}
      data-signed={src ? '1' : '0'}
      {...(isStorage ? { crossOrigin: 'anonymous' } : {})}
      onError={handleError}
      {...rest}
    />
  )
}
