import { storagePathFromUrl, useSignedUrl } from '../lib/signedUrls'

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
 */
export default function SignedImage({ bucket, stored, alt = '', ...rest }) {
  const url = useSignedUrl(stored, bucket)
  // ⚠️ 桶里的图片要用 **CORS 请求**（crossorigin="anonymous"）：
  //    ① 这样 Service Worker 里 fetch 到的响应不是 opaque（能读到 200 状态码），
  //       才能安全地按对象路径缓存字节 —— 否则响应状态是 0，只能全部放弃缓存；
  //    ② 跨域图片的传输字节也能被性能面板/测试量到。
  //    外链（测试里的 favicon 等）不加 crossorigin：那些服务器不一定回 CORS 头，
  //    加了反而会加载失败。
  const isStorage = !!storagePathFromUrl(stored)
  return (
    <img
      src={url ?? undefined}
      alt={alt}
      data-signed={url ? '1' : '0'}
      {...(isStorage ? { crossOrigin: 'anonymous' } : {})}
      {...rest}
    />
  )
}
