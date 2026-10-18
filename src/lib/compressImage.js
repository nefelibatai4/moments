// 上传前图片压缩
//
// 目的：Storage 免费额度只有 1GB，手机原图动辄 3~8MB，直接上传很快就满。
// 这里用 canvas 等比缩放到长边不超过 maxDim，再以 JPEG 重编码。
//
// 几个刻意的取舍：
//   * GIF 原样返回——可能是动图，canvas 重编码会丢帧
//   * 动图 WebP / APNG 也原样返回——同理，重编码只剩第一帧
//     （按字节嗅探 `ANIM` / `acTL` 块判断，不依赖 WebCodecs）
//   * 解码失败原样返回——压缩是优化，不该阻断用户发图
//   * 压完反而更大时保留原图（小图重编码偶尔会变大）
//   * 透明图先铺白底——JPEG 不支持 alpha，否则透明区会变黑
//   * 传 imageOrientation: 'from-image' 让手机照片遵循 EXIF 方向，
//     否则竖拍照片会被压成横的
//   * HEIC 一定要转：iPhone 默认格式，桌面 Chrome 根本解不开（打开是一片空白），
//     所以哪怕体积很小也不走「小图跳过」的捷径。解码走 <img> 兜底——
//     iOS Safari 能在 <img> 里解 HEIC，但 createImageBitmap 不一定行。

const DEFAULT_MAX_DIM = 1600
const DEFAULT_QUALITY = 0.82
// 尺寸没超标且体积已经很小，就没必要重编码
const SKIP_BELOW_BYTES = 300 * 1024
// 嗅探动图只看文件头这么多字节（ANIM/acTL 都在最前面）
const SNIFF_BYTES = 64 * 1024

const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'])

function toJpegName(name) {
  const base = name.replace(/\.[^./\\]+$/, '')
  return `${base || 'image'}.jpg`
}

function isHeic(file) {
  if (HEIC_TYPES.has(file.type)) return true
  return /\.(heic|heif)$/i.test(file.name || '')
}

function hasChunkAt(buf, at, tag) {
  if (buf.length < at + tag.length) return false
  for (let i = 0; i < tag.length; i += 1) if (buf[at + i] !== tag.charCodeAt(i)) return false
  return true
}

function hasChunk(buf, tag) {
  for (let i = 0; i + 4 <= buf.length; i += 1) if (hasChunkAt(buf, i, tag)) return true
  return false
}

/** 动图（WebP 的 ANIM / APNG 的 acTL）——重编码会丢帧，直接原样传 */
export async function looksAnimated(file) {
  try {
    const buf = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer())
    const isWebp = buf.length > 12 && hasChunkAt(buf, 0, 'RIFF') && hasChunkAt(buf, 8, 'WEBP')
    const isPng = buf.length > 8 && buf[0] === 0x89 && hasChunkAt(buf, 1, 'PNG')
    if (isWebp) return hasChunk(buf, 'ANIM')
    if (isPng) return hasChunk(buf, 'acTL')
    return false
  } catch {
    return false
  }
}

/** 用 <img> 解一次（iOS 上 HEIC 只有这条路能解），返回可绘制的源 */
async function decodeViaImg(file) {
  if (typeof Image !== 'function' || typeof URL?.createObjectURL !== 'function') return null
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'sync'
    img.src = url
    if (typeof img.decode === 'function') await img.decode()
    else await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject })
    if (!img.naturalWidth || !img.naturalHeight) return null
    return img
  } catch {
    return null
  } finally {
    // 画到 canvas 之前不能释放，所以调用方负责延后释放；这里只把 url 挂到对象上
    // eslint-disable-next-line no-param-reassign
    file.__objectUrl = url
  }
}

function releaseObjectUrl(file) {
  if (file?.__objectUrl && typeof URL?.revokeObjectURL === 'function') {
    URL.revokeObjectURL(file.__objectUrl)
    file.__objectUrl = null
  }
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      try {
        return await createImageBitmap(file)
      } catch {
        /* 落到 <img> 兜底 */
      }
    }
  }
  return decodeViaImg(file)
}

/**
 * @returns {Promise<File>} 压缩后的文件；不划算或无法处理时返回原文件
 */
export async function compressImage(file, { maxDim = DEFAULT_MAX_DIM, quality = DEFAULT_QUALITY } = {}) {
  if (!file || !file.type?.startsWith('image/')) return file
  if (file.type === 'image/gif') return file
  if (typeof document === 'undefined') return file

  if (await looksAnimated(file)) return file

  const heic = isHeic(file)
  const bitmap = await decode(file)
  if (!bitmap) {
    releaseObjectUrl(file)
    return file
  }

  const width = bitmap.width || bitmap.naturalWidth
  const height = bitmap.height || bitmap.naturalHeight
  const scale = Math.min(1, maxDim / Math.max(width, height))
  const targetW = Math.max(1, Math.round(width * scale))
  const targetH = Math.max(1, Math.round(height * scale))

  // HEIC 不跳过：宁可重编码也要变成桌面能看的 JPEG
  if (!heic && scale === 1 && file.size <= SKIP_BELOW_BYTES) {
    bitmap.close?.()
    releaseObjectUrl(file)
    return file
  }

  try {
    const canvas = document.createElement('canvas')
    canvas.width = targetW
    canvas.height = targetH
    const ctx = canvas.getContext('2d')
    if (!ctx) return file

    // 铺白底，避免 PNG 透明区域在 JPEG 里变黑
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, targetW, targetH)
    ctx.drawImage(bitmap, 0, 0, targetW, targetH)

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
    if (!blob) return file
    // HEIC 例外：就算压完更大，也换掉（兼容性优先）
    if (!heic && blob.size >= file.size) return file

    return new File([blob], toJpegName(file.name), {
      type: 'image/jpeg',
      lastModified: Date.now(),
    })
  } catch {
    return file
  } finally {
    bitmap.close?.()
    releaseObjectUrl(file)
  }
}
