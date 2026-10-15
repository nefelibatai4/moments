import { useEffect, useRef, useState } from 'react'
import { fetchAndDecryptImage } from '../lib/imageCrypto'
import { resolveSignedUrl, useSignedUrls } from '../lib/signedUrls'

/**
 * 动态里的短视频（2026-10-15 使用者："保留视频自动播放吧"）。
 *
 * 为什么要有这个组件、而不是直接 `<video src=...>`：
 *   · 视频和封面都是**端到端加密**的，得先解密成 `blob:` 才能播（见 lib/imageCrypto.js）；
 *   · 视频比图片大一个量级，**绝不能一屏全下**：封面先出（几 KB），**只有滚到可见**才去下视频；
 *   · 一屏多个视频一起自动播会同时吃解码器、CPU 和电 → 同屏最多 2 个在播（与下雨特效同一套护栏）；
 *   · 系统开「减少动态效果」时**不自动播**，只显示封面 + 一个播放按钮（想看点一下）。
 *
 * 实现取舍（踩过坑，记下来）：
 *   视频本体的加载**刻意不借** `useContentImageUrls` 那套"共享解密缓存"。那套是给
 *   "同一张图到处都在渲染"（卡片 + 灯箱 + 重挂载）设计的，重渲染由"谁解出来的"驱动；
 *   视频这里只有一个消费者，直接自己加载 + 自己 setState 更好推理
 *   （实测：借那套会出现"缓存里明明有、界面就是停在封面"）。
 *
 * DOM 契约（验收脚本按这些选）：
 *   `[data-moment-video]`、`data-video-mode="playing" | "paused" | "poster"`、
 *   `data-video-loaded="1"`、`data-video-reduced="1"`、`data-video-visible="0|1"`
 */
const MAX_PLAYING = 2
let playingCount = 0

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** 交给 `<video>` 的 MIME：按后缀给（浏览器对视频的 MIME 比图片挑） */
function videoMime(locator) {
  const p = String(locator).split('?')[0].toLowerCase()
  if (p.endsWith('.mov')) return 'video/quicktime'
  if (p.endsWith('.webm')) return 'video/webm'
  if (p.endsWith('.m4v')) return 'video/x-m4v'
  return 'video/mp4'
}

export default function MomentVideo({ item, resolveKey }) {
  const [visible, setVisible] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [open, setOpen] = useState(false)
  const [videoUrl, setVideoUrl] = useState(null)
  const [posterUrl, setPosterUrl] = useState(null)
  const boxRef = useRef(null)
  const videoRef = useRef(null)
  const countedRef = useRef(false)
  const reduced = prefersReducedMotion()

  // 封面（小，立刻要）：走通用的批量签名（带缓存）
  const posterUrls = useSignedUrls(item?.poster ? [item.poster] : [], 'moment-images')
  const posterSigned = item?.poster ? posterUrls.get(item.poster) ?? null : null

  // "在播"状态跟着 `<video>` 自己的事件走（事件才是真相：卡顿、系统暂停、解码器被抢占都算）
  function onPlay() { setPlaying(true) }
  function onPause() {
    releaseSlot()
    setPlaying(false)
  }
  function releaseSlot() {
    if (!countedRef.current) return
    countedRef.current = false
    playingCount = Math.max(0, playingCount - 1)
  }

  // 可见性：进到视野才去下视频（阈值 0.25；卡片可能很高，阈值太高会出现"看着它却永远不播"）
  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof IntersectionObserver !== 'function') { setVisible(true); return undefined }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => setVisible(e.isIntersecting)),
      { threshold: 0.25 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // 封面：拿到签名地址就解密（几百毫秒的事，先把静帧铺上）
  useEffect(() => {
    if (!posterSigned || posterUrl) return undefined
    let cancelled = false
    ;(async () => {
      const key = await resolveKey().catch(() => null)
      if (!key) return
      const out = await fetchAndDecryptImage(posterSigned, key, 'image')
      if (out && !cancelled) setPosterUrl(URL.createObjectURL(new Blob([out.bytes], { type: 'image/jpeg' })))
    })()
    return () => { cancelled = true }
  }, [posterSigned, posterUrl, resolveKey])

  // 视频本体：可见 + 没开"减少动效"时才下载 → 解密 → blob。失败按 1s/3s/8s 有界重试。
  // ⚠️ "还没拿到钥匙"（身份密钥正在解锁、CEK 还在路上）也算失败的一种，要重试 ——
  //    真正防流量的是"只在可见时才下"，不靠这里少试几次。
  useEffect(() => {
    if (!item?.video || !visible || reduced || videoUrl) return undefined
    let cancelled = false
    ;(async () => {
      for (let round = 0; round < 4 && !cancelled; round += 1) {
        if (round > 0) await new Promise((r) => setTimeout(r, [1000, 3000, 8000][round - 1] ?? 8000))
        if (cancelled) return
        try {
          const key = await resolveKey().catch(() => null)
          if (!key) continue
          const url = await resolveSignedUrl('moment-images', item.video).catch(() => null)
          if (!url) continue
          const out = await fetchAndDecryptImage(url, key, 'video')
          if (!out || cancelled) continue
          setVideoUrl(URL.createObjectURL(new Blob([out.bytes], { type: videoMime(item.video) })))
          return
        } catch { /* 下一轮再试 */ }
      }
    })()
    return () => { cancelled = true }
  }, [item?.video, visible, reduced, videoUrl, resolveKey])

  // 自动播放/暂停：可见 + 有地址 + 没开"减少动效" + 同屏额度没满
  useEffect(() => {
    const el = videoRef.current
    if (!el || !videoUrl) return undefined
    const shouldPlay = visible && !reduced && !document.hidden
    if (!shouldPlay) {
      if (!el.paused) el.pause()
      return undefined
    }
    // ⚠️ **先占位再播**：三个视频常常在同一帧里一起判断，如果都读 `playingCount` 再各自播，
    //    就会同时冲过上限（实测 3 个全在播）。占位是同步的，第二个/第三个就会看到额度已满。
    if (!countedRef.current) {
      if (playingCount >= MAX_PLAYING) return undefined   // 额度满了：等别人滚走
      countedRef.current = true
      playingCount += 1
    }
    el.play().catch(() => {
      releaseSlot()   // 播不起来（比如 iOS 拒绝自动播）就把额度还回去
    })
    return undefined
  }, [videoUrl, visible, reduced])

  // 离开视野/切后台一定要停（省电，也避免多个视频一起出声）
  useEffect(() => {
    const onHide = () => {
      const el = videoRef.current
      if (el && !el.paused) el.pause()
    }
    document.addEventListener('visibilitychange', onHide)
    return () => { document.removeEventListener('visibilitychange', onHide); onHide() }
  }, [])

  if (!item?.video) return null

  const mode = playing ? 'playing' : (videoUrl ? 'paused' : 'poster')

  return (
    <div
      className="moment-video"
      ref={boxRef}
      data-moment-video="1"
      data-video-visible={visible ? '1' : '0'}
    >
      <button
        type="button"
        className="moment-video-frame"
        onClick={() => setOpen(true)}
        aria-label="播放这段视频"
        style={item.w && item.h ? { aspectRatio: `${item.w} / ${item.h}` } : undefined}
      >
        {posterUrl
          ? <img src={posterUrl} alt="" data-video-poster="1" />
          : <span className="moment-video-placeholder" aria-hidden="true" />}
        <video
          ref={videoRef}
          src={videoUrl ?? undefined}
          poster={posterUrl ?? undefined}
          muted
          loop
          playsInline
          preload="none"
          onPlay={onPlay}
          onPause={onPause}
          data-video-mode={mode}
          {...(videoUrl ? { 'data-video-loaded': '1' } : {})}
          {...(reduced ? { 'data-video-reduced': '1' } : {})}
        />
        {!playing && (
          <span className="moment-video-badge" aria-hidden="true">
            {reduced && videoUrl ? '▶ 点开播放' : '🎬'}
          </span>
        )}
      </button>
      <p className="moment-video-hint">{(item.ms / 1000).toFixed(1)} 秒 · 点开有声音</p>

      {open && (
        <div className="moment-video-lightbox" role="dialog" aria-label="视频播放" onClick={() => setOpen(false)}>
          <video
            src={videoUrl ?? undefined}
            controls
            autoPlay
            playsInline
            onClick={(e) => e.stopPropagation()}
            className="moment-video-full"
          />
          <button type="button" className="moment-video-close" onClick={() => setOpen(false)}>关闭</button>
        </div>
      )}
    </div>
  )
}
