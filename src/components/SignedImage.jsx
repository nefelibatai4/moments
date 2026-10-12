import { useEffect } from 'react'
import { useSignedUrl } from '../lib/signedUrls'

/**
 * 私有桶里的图片（见 lib/signedUrls.js）。
 *
 * 签名要走一次网络，所以第一帧可能还没有地址 —— 这时渲染一个**没有 src 的 `<img>`**：
 * 不裂图、不弹 alt 文本，CSS 的尺寸规则（`.moment-avatar img { … }`）也照样生效，
 * 拿到地址后自动换成真图（同一个元素，不会二次布局）。
 * 测试可以看 `data-signed="1"` 判断"地址已经拿到了"。
 *
 * ⚠️ 拿到地址后如果还要用（例如灯箱、下载链接），用 `onResolved` 回传，
 *    不要在调用处自己再拼 URL —— 那会绕开缓存、变成每张图一个请求。
 */
export default function SignedImage({ bucket, stored, alt = '', onResolved, ...rest }) {
  const url = useSignedUrl(stored, bucket)

  useEffect(() => {
    if (url && onResolved) onResolved(url)
  }, [url, onResolved])

  return <img src={url ?? undefined} alt={alt} data-signed={url ? '1' : '0'} {...rest} />
}
