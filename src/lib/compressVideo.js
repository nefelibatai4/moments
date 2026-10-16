/**
 * 端上压缩视频（2026-10-15）。
 *
 * 为什么需要：浏览器**没法像图片那样直接压**视频 —— 传上去多大就是多大。使用者那段
 * DJI 片段 10 秒就 56 MB，直接发会让存储和流量很难看（我们只有 1GB 免费额度）。
 *
 * 做法（全部在本机完成，不上传任何东西）：
 *   ① 用 `<video>` 解码原片；
 *   ② 逐帧画进 canvas（长边缩到 maxDim，默认 1280），再用 `MediaRecorder` 重新编码；
 *   ③ 音轨：能拿到就一起录（`video.captureStream()` 的 audio track），拿不到就只有画面；
 *   ④ 产出**比原文件小**才用，否则保留原片（绝不越压越大）。
 *
 * 容器/编码规则（很重要）：
 *   · 原片是 mp4/quicktime → **必须**产出 mp4（H.264）才用，否则保留原片。
 *     因为 iPhone 的 HEVC 在电脑 Chrome 上播不了，而 webm 在 iOS 上又播不了 ——
 *     在这条链路上"换个容器"只会把能播的变成不能播的。
 *   · 原片本身就是 webm（桌面 Chrome 录的）→ 产出 webm 即可（同一个平台家族）。
 *
 * 代价：录制是**实时**的（10 秒视频 ≈ 10 秒），所以有进度回调，界面上要说清楚。
 */
// 小于这个就别折腾（实时录制要花掉与视频等长的时间，得不偿失）。
// 定在 2MB：手机随手拍的视频基本都超过它，而它以下的片段本来就够小。
const SMALL_ENOUGH = 2 * 1024 * 1024
const DEFAULT_MAX_DIM = 1280
// 1280 长边 + 1.6Mbps：10 秒约 2MB，微信/朋友圈那个量级的观感（实测 56MB 的 DJI 片段能到 1/10 以下）
const DEFAULT_BITRATE = 1_600_000

const mp4Supported = () => {
  try { return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E') } catch { return false }
}
const webmSupported = () => {
  try {
    return typeof MediaRecorder !== 'undefined'
      && (MediaRecorder.isTypeSupported('video/webm;codecs=vp9') || MediaRecorder.isTypeSupported('video/webm;codecs=vp8'))
  } catch { return false }
}

/** 原片是 mp4/mov 家族吗（iPhone 直出、相机导出都算） */
const isMp4Family = (file) => /mp4|quicktime|m4v/i.test(file.type || '') || /\.(mp4|mov|m4v)$/i.test(file.name || '')

function pickMime(file) {
  if (isMp4Family(file)) return mp4Supported() ? 'video/mp4;codecs=avc1.42E01E' : null
  if (webmSupported()) return MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8'
  return mp4Supported() ? 'video/mp4;codecs=avc1.42E01E' : null
}

/**
 * @param {File} file 原视频
 * @param {{ maxDim?: number, bitrate?: number, onProgress?: (ratio:number)=>void, signal?: AbortSignal }} opts
 * @returns {Promise<{ blob: Blob, name: string, type: string, compressed: boolean, reason?: string }>}
 */
export async function compressVideo(file, opts = {}) {
  const { maxDim = DEFAULT_MAX_DIM, bitrate = DEFAULT_BITRATE, onProgress } = opts
  const keep = (reason) => {
    console.warn('[video] 不压缩：', reason, `（${(file.size / 1024 / 1024).toFixed(1)} MB）`)
    return { blob: file, name: file.name, type: file.type || 'video/mp4', compressed: false, reason }
  }

  if (file.size <= SMALL_ENOUGH) return keep('本来就够小')
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    return keep('这个浏览器不支持端上录制')
  }
  const mime = pickMime(file)
  if (!mime) return keep('这个浏览器编不出目的地格式（保留原片）')

  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.src = url
  video.muted = true          // 必须静音才能自动播放/解码（音轨另外抓）
  video.playsInline = true
  video.preload = 'auto'

  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve
      video.onerror = () => reject(new Error('这个浏览器解不开这段视频'))
      setTimeout(() => reject(new Error('读取视频信息超时')), 15000)
    })
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    if (!duration) return keep('读不到时长')

    const scale = Math.min(1, maxDim / Math.max(video.videoWidth || 1, video.videoHeight || 1))
    const w = Math.max(2, Math.round((video.videoWidth || 2) * scale / 2) * 2)
    const h = Math.max(2, Math.round((video.videoHeight || 2) * scale / 2) * 2)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')

    const stream = canvas.captureStream(30)
    // 音轨：拿得到就一起录（Chrome/Safari 较新版本支持；拿不到就静音，别让整个功能失败）
    try {
      const src = video.captureStream?.()
      for (const t of src?.getAudioTracks?.() ?? []) stream.addTrack(t)
    } catch { /* 没有音轨就算了 */ }

    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate })
    const chunks = []
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
    const stopped = new Promise((resolve) => { rec.onstop = resolve })

    rec.start(250)
    await video.play()
    const t0 = performance.now()
    // ⚠️ 必须有一条**死线**：页面切后台、无头浏览器、或解码器完全不前进时，
    //    录制循环会一直转下去 → 发布就永远卡在"压缩中"（实测踩到）。
    //    到点就收尾：拿到什么算什么，拿不到就保留原片。
    const deadline = t0 + duration * 1000 * 1.6 + 8000
    await new Promise((resolve) => {
      const tick = () => {
        ctx.drawImage(video, 0, 0, w, h)
        const ratio = duration ? Math.min(1, (performance.now() - t0) / (duration * 1000)) : 0
        onProgress?.(ratio)
        if (video.ended || video.currentTime >= duration - 0.02) { resolve(); return }
        if (performance.now() > deadline) { console.warn('[video] 压缩到死线仍未结束，用已录到的部分'); resolve(); return }
        requestAnimationFrame(tick)
      }
      tick()
    })
    rec.stop()
    await stopped
    onProgress?.(1)

    const blob = new Blob(chunks, { type: mime.split(';')[0] })
    // 只在**真的更小**时替换（否则保留原片，免得越压越大）
    if (!blob.size || blob.size >= file.size * 0.9) return keep('压完没有更小，保留原片')
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm'
    const base = (file.name || 'video').replace(/\.[^.]+$/, '')
    return { blob, name: `${base}.${ext}`, type: mime.split(';')[0], compressed: true }
  } catch (err) {
    return keep(err?.message || '压缩失败')
  } finally {
    video.pause?.()
    URL.revokeObjectURL(url)
  }
}
