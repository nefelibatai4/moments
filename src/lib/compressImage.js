// 上传前图片压缩
//
// 目的：Storage 免费额度只有 1GB，手机原图动辄 3~8MB，直接上传很快就满。
// 这里用 canvas 等比缩放到长边不超过 maxDim，再以 JPEG 重编码。
//
// 几个刻意的取舍：
//   * GIF 原样返回——可能是动图，canvas 重编码会丢帧
//   * 解码失败原样返回——压缩是优化，不该阻断用户发图
//   * 压完反而更大时保留原图（小图重编码偶尔会变大）
//   * 透明图先铺白底——JPEG 不支持 alpha，否则透明区会变黑
//   * 传 imageOrientation: 'from-image' 让手机照片遵循 EXIF 方向，
//     否则竖拍照片会被压成横的

const DEFAULT_MAX_DIM = 1600
const DEFAULT_QUALITY = 0.82
// 尺寸没超标且体积已经很小，就没必要重编码
const SKIP_BELOW_BYTES = 300 * 1024

function toJpegName(name) {
  const base = name.replace(/\.[^./\\]+$/, '')
  return `${base || 'image'}.jpg`
}

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    try {
      return await createImageBitmap(file)
    } catch {
      return null
    }
  }
}

/**
 * @returns {Promise<File>} 压缩后的文件；不划算或无法处理时返回原文件
 */
export async function compressImage(file, { maxDim = DEFAULT_MAX_DIM, quality = DEFAULT_QUALITY } = {}) {
  if (!file || !file.type?.startsWith('image/')) return file
  if (file.type === 'image/gif') return file
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return file

  const bitmap = await decode(file)
  if (!bitmap) return file

  const { width, height } = bitmap
  const scale = Math.min(1, maxDim / Math.max(width, height))
  const targetW = Math.max(1, Math.round(width * scale))
  const targetH = Math.max(1, Math.round(height * scale))

  if (scale === 1 && file.size <= SKIP_BELOW_BYTES) {
    bitmap.close?.()
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
    if (!blob || blob.size >= file.size) return file

    return new File([blob], toJpegName(file.name), {
      type: 'image/jpeg',
      lastModified: Date.now(),
    })
  } catch {
    return file
  } finally {
    bitmap.close?.()
  }
}
