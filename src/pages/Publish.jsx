import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { safeStorageKey } from '../lib/sanitizeFilename'
import { compressImage } from '../lib/compressImage'
import { CARD_COLORS } from '../lib/cardColors'
import { objectLocator } from '../lib/signedUrls'
import { MOODS } from '../lib/moods'
import { circleReady, createMomentKey, encryptCircleText } from '../lib/crypto'
import { uploadEncryptedBytes, uploadEncryptedImage } from '../lib/imageCrypto'
import { compressVideo } from '../lib/compressVideo'

/**
 * 读视频的时长/分辨率，并抽首帧当封面（全部在本机完成）。
 * ⚠️ 抽帧要往后挪一点点：不少视频第一帧是黑的，封面会难看。
 */
async function prepareVideo(file) {
  const url = URL.createObjectURL(file)
  const el = document.createElement('video')
  el.preload = 'metadata'
  el.muted = true
  el.playsInline = true
  el.src = url
  try {
    await new Promise((resolve, reject) => {
      el.onloadedmetadata = resolve
      el.onerror = () => reject(new Error('这个浏览器打不开这段视频（iPhone 的 HEVC 常见；换一段 H.264 试试）'))
      setTimeout(() => reject(new Error('读取视频信息超时')), 12000)
    })
    const w = el.videoWidth
    const h = el.videoHeight
    const ms = Math.round((el.duration || 0) * 1000)
    if (!w || !h) throw new Error('读不到视频尺寸')
    await new Promise((resolve) => {
      el.onseeked = resolve
      el.currentTime = Math.min(0.15, (el.duration || 1) / 3)
      setTimeout(resolve, 4000)     // 有的容器不给 seeked，兜底别卡死
    })
    const scale = Math.min(1, 1280 / Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height)
    const posterBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82))
    if (!posterBlob) throw new Error('封面生成失败')
    return { w, h, ms, posterBlob }
  } finally {
    URL.revokeObjectURL(url)
  }
}

// 超过这个字数，动态页默认折叠（只露前几行）；写的时候完全不拦。
// 这个数字取"原来那个 maxLength"（1000），保证老习惯不变、老内容形态不变。
const FOLD_AT = 1000
// 防误操作的硬顶（不是内容限制）：整篇论文粘进来会让时间线一屏放不下、解密也变慢。
const SAFETY_MAX = 20000
// 短视频的护栏（2026-10-15 使用者："保留视频自动播放"）。浏览器**没法压缩视频**，
// 传上去多大就是多大 —— 所以只能在入口把住：一条动态一段、限时长、限体积。
// 依据：3~10 秒的 H.264 大概 2~5 MB；20 秒是"还能忍"的上限。
// 2026-10-15 使用者问"25MB 的出发点、能不能扩大"→ 提高到 50 MB（覆盖绝大多数手机视频，
// 包括那段 56 MB 的高码率 DJI 片段），并计划接上"发布时自动压缩"（压完上限就不再是痛点）。
const VIDEO_MAX_MS = 20_000
const VIDEO_MAX_BYTES = 50 * 1024 * 1024

export default function Publish() {
  const session = useAuth()
  const navigate = useNavigate()
  const [content, setContent] = useState('')
  const [files, setFiles] = useState([])
  const [location, setLocation] = useState(null)
  const [locating, setLocating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [mood, setMood] = useState(null)
  const [anonMode, setAnonMode] = useState(false)
  const [anonNickname, setAnonNickname] = useState('')
  const [error, setError] = useState(null)
  const [uploadHint, setUploadHint] = useState(null)
  const [cardColor, setCardColor] = useState('default')
  // 短视频：一条动态最多一段；poster 是本地抽出来的首帧（必须，不然"只看一格静图"
  // 也要先把整段视频下下来，流量和体验都受不了）
  const [video, setVideo] = useState(null)

  function handleGetLocation() {
    if (!navigator.geolocation) {
      setError('当前浏览器不支持定位')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude })
        setLocating(false)
      },
      () => {
        setError('无法获取位置，请检查定位权限')
        setLocating(false)
      }
    )
  }

  /**
   * 选了一段视频：先在**本机**读出时长/分辨率，并抽出首帧当封面。
   * ⚠️ 这里也是"能不能发"的第一道关：Chrome 解不开 HEVC（iPhone 直出的常见编码），
   *    解不开就在这里当场说清楚，而不是等传上去发现没法播。
   */
  async function handleVideoChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''            // 允许"选错了再选同一个文件"
    if (!file) return
    setError(null)
    if (!file.type.startsWith('video/')) { setError('这看起来不是视频文件'); return }
    if (file.size > VIDEO_MAX_BYTES) {
      setError(`这段视频 ${(file.size / 1024 / 1024).toFixed(1)} MB，超过 ${VIDEO_MAX_BYTES / 1024 / 1024} MB 了`)
      return
    }
    // 超过这个大小就压一遍（2026-10-15 使用者批准）：56MB → 5MB 上下，顺带把
    // iPhone 的 HEVC 转成 H.264（电脑端也能播）。压不动就保留原片，绝不越压越大。
    const COMPRESS_OVER = 6 * 1024 * 1024
    setUploadHint('读取视频…')
    try {
      const meta = await prepareVideo(file)
      if (meta.ms > VIDEO_MAX_MS) {
        setError(`这段视频 ${(meta.ms / 1000).toFixed(1)} 秒，超过 ${VIDEO_MAX_MS / 1000} 秒了`)
        setUploadHint(null)
        return
      }
      let uploadFile = file
      let compressedInfo = null
      if (file.size > COMPRESS_OVER) {
        const res = await compressVideo(file, {
          onProgress: (r) => setUploadHint(`压缩视频… ${Math.round(r * 100)}%（本机进行，不上传）`),
        })
        if (res.compressed) {
          uploadFile = new File([res.blob], res.name, { type: res.type })
          compressedInfo = { from: file.size, to: uploadFile.size }
        }
      }
      setUploadHint(null)
      setVideo({
        file: uploadFile,
        ...meta,
        compressedInfo,
        previewUrl: URL.createObjectURL(file),
        posterUrl: URL.createObjectURL(meta.posterBlob),
      })
    } catch (err) {
      setError(err.message)
    }
    setUploadHint(null)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (content.length > SAFETY_MAX) {
      setError(`太长了（上限 ${SAFETY_MAX} 字），分几条发吧`)
      return
    }
    if (!content.trim() && files.length === 0 && !video) {
      setError('请输入文字、选择图片或视频')
      return
    }
    setSubmitting(true)
    setError(null)

    try {
      const text = content.trim() || null
      const momentId = crypto.randomUUID()
      // ⚠️ 顺序是刻意的：**先按明文入库（图片先不填），成功了再换成密文**。
      //    中间任何一步失败（比如给对方包钥匙失败、某张图上传失败）都不会让内容变成
      //    "谁也看不懂"，顶多这条动态暂时还是明文（下次打开会自动补加密，见 lib/circleSync.js）。
      //    先入库还有一个原因：图片要用"这条动态的 CEK"加密，而 CEK 的包裹表要求动态已经存在。
      const { error: insertError } = await supabase.from('moments').insert({
        id: momentId,
        content: text,
        images: null,
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
        user_id: session.user.id,
        anon_nickname: anonMode ? anonNickname.trim() || null : null,
        // 心情（明文元数据，白名单见 db-backups/20261014_moment_mood.sql）
        mood: mood || null,
        // 卡片颜色：default 存 null（历史数据也是 null，两边含义一致）
        card_color: cardColor === 'default' ? null : cardColor,
      })
      if (insertError) throw insertError

      // 端到端加密（阶段 2 文字 / 阶段 3 图片）：给每位成员包一份 CEK。
      // 圈子里只要还有成员的公钥世代对不上，就**整条不加密**（有人解不开 = 有人看不到）。
      const { ready, members } = await circleReady()
      const cek = ready ? await createMomentKey(momentId, members) : null

      // 图片：先压缩，再用这条动态的 CEK 加密上传（拿不到钥匙就退回明文上传）
      const imageUrls = []
      let index = 0
      for (const file of files) {
        index += 1
        setUploadHint(files.length > 1 ? `处理图片 ${index}/${files.length}…` : '处理图片…')
        // 先压缩再上传：手机原图常有几 MB，直接传很快会吃满 Storage 配额
        const prepared = await compressImage(file)
        const path = safeStorageKey(session.user.id, prepared.name)
        const up = cek ? await uploadEncryptedImage(path, prepared, cek) : { ok: false, reason: 'no-key' }
        if (!up.ok) {
          console.warn('[image] 这张图片没能加密，按明文上传:', up.reason)
          const { error: uploadError } = await supabase.storage
            .from('moment-images')
            .upload(path, prepared, { contentType: prepared.type })
          if (uploadError) throw uploadError
        }
        // 桶已私有：存**定位串**（本身不可访问），渲染时统一换签名地址（见 lib/signedUrls.js）
        imageUrls.push(objectLocator('moment-images', path))
      }
      // 视频：和图片一样，用这条动态的 CEK 加密上传（连首帧封面一起）。
      // 解密出来的字节是原样视频，所以 MIME 按后缀给（见 lib/imageCrypto.js）。
      let videoEntry = null
      if (video) {
        setUploadHint('加密上传视频…')
        const vPath = safeStorageKey(session.user.id, video.file.name)
        const vUp = cek ? await uploadEncryptedBytes(vPath, video.file, cek) : { ok: false, reason: 'no-key' }
        if (!vUp.ok) {
          console.warn('[video] 没能加密，按明文上传:', vUp.reason)
          const { error: vErr } = await supabase.storage
            .from('moment-images')
            .upload(vPath, video.file, { contentType: video.file.type || 'video/mp4' })
          if (vErr) throw vErr
        }
        const posterFile = new File([video.posterBlob], `poster-${Date.now()}.jpg`, { type: 'image/jpeg' })
        const pPath = safeStorageKey(session.user.id, posterFile.name)
        const pUp = cek ? await uploadEncryptedBytes(pPath, posterFile, cek) : { ok: false, reason: 'no-key' }
        if (!pUp.ok) {
          const { error: pErr } = await supabase.storage
            .from('moment-images')
            .upload(pPath, posterFile, { contentType: 'image/jpeg' })
          if (pErr) throw pErr
        }
        videoEntry = {
          video: objectLocator('moment-images', vPath),
          poster: objectLocator('moment-images', pPath),
          w: video.w, h: video.h, ms: video.ms,
        }
      }
      setUploadHint(null)

      // 回写：图片/视频定位串 + 正文密文（媒体用的钥匙就是这条 CEK，不需要额外记录）
      const patch = { images: imageUrls.length > 0 ? imageUrls : null }
      if (videoEntry) patch.videos = [videoEntry]
      if (text && cek) {
        const sealed = await encryptCircleText(cek, text)
        if (sealed) Object.assign(patch, sealed, { content: null })
      }
      const { error: patchError } = await supabase.from('moments').update(patch).eq('id', momentId)
      if (patchError) console.warn('[circle] 动态回写失败（内容仍是明文）:', patchError.message)

      navigate('/')
    } catch (err) {
      setError(err.message)
    } finally {
      setUploadHint(null)
      setSubmitting(false)
    }
  }

  return (
    <form className="publish-form" onSubmit={handleSubmit}>
      <h2>发布动态</h2>
      {/* ⚠️ 刻意**不设 maxLength**：使用者 2026-10-14 要求"发布不要有字数限制"。
          长文不是靠拦，而是靠**在读的时候折叠**（超过 FOLD_AT 字，动态里默认只露前几行，
          点「全文」就地展开）—— 写的人不必迁就显示形态。
          唯一的硬顶是 SAFETY_MAX：防的不是长文，是"整篇论文粘进来"这类误操作。 */}
      <textarea
        placeholder="分享点什么…"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={5}
      />
      <div className="publish-count-row">
        <span className={content.length > SAFETY_MAX ? 'publish-count over' : 'publish-count'}>
          {content.length > 0 ? `${content.length} 字` : ''}
        </span>
        {content.length > FOLD_AT && content.length <= SAFETY_MAX && (
          <span className="publish-count-hint">发出去后在动态里默认折叠，点「全文」看全部</span>
        )}
        {content.length > SAFETY_MAX && (
          <span className="publish-count-hint over">太长了（上限 {SAFETY_MAX} 字），分几条发吧</span>
        )}
      </div>
      <input
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => setFiles(Array.from(e.target.files))}
      />

      {/* 短视频（2026-10-15）：一条动态最多一段。
          ⚠️ 只用原生 `<label>` 包一个**可见**的 input：iOS 上 hidden input + 程序化 click 会失灵。 */}
      <div className="publish-video-row">
        <label className="publish-video-pick">
          {video ? '换一段视频' : '🎬 加一段视频'}
          <input type="file" accept="video/*" onChange={handleVideoChange} />
        </label>
        {video && (
          <div className="publish-video-info">
            <video
              className="publish-video-thumb"
              src={video.previewUrl}
              poster={video.posterUrl}
              muted
              playsInline
              preload="metadata"
            />
            <span className="status-text">
              {(video.ms / 1000).toFixed(1)} 秒 · {video.w}×{video.h} ·
              {' '}{(video.file.size / 1024 / 1024).toFixed(1)} MB
              {video.compressedInfo && (
                <> · 已压缩（原 {(video.compressedInfo.from / 1024 / 1024).toFixed(0)} MB）</>
              )}
            </span>
            <button
              type="button"
              className="publish-video-remove"
              onClick={() => {
                URL.revokeObjectURL(video.previewUrl)
                URL.revokeObjectURL(video.posterUrl)
                setVideo(null)
              }}
            >
              去掉
            </button>
          </div>
        )}
        <p className="status-text publish-video-hint">
          最长 {VIDEO_MAX_MS / 1000} 秒、{VIDEO_MAX_BYTES / 1024 / 1024} MB 以内；发出去后在动态里会自动播放（静音）。
        </p>
      </div>
      <div className="location-row">
        <button type="button" onClick={handleGetLocation} disabled={locating}>
          {location ? `📍 已添加位置` : locating ? '定位中…' : '📍 添加当前位置'}
        </button>
      </div>
      <div className="anon-publish-row">
        <label className="anon-toggle">
          <input type="checkbox" checked={anonMode} onChange={(e) => setAnonMode(e.target.checked)} />
          匿名发布
        </label>
        {anonMode && (
          <input
            type="text"
            placeholder="自定义显示名称"
            value={anonNickname}
            onChange={(e) => setAnonNickname(e.target.value)}
            maxLength={12}   /* 同上：卡片头一行放不下更长的 */
          />
        )}
      </div>
      {/* 卡片颜色：一排色点，选中的描一圈蓝边（微博那种"给这条动态挑个底色"） */}
      {/* 心情：和"卡片颜色"同一层（都是这条动态的样子），先只做"下雨" */}
      <div className="mood-row" role="group" aria-label="心情">
        <span className="mood-row-label">心情</span>
        <button
          type="button"
          className={`mood-chip${mood === null ? ' on' : ''}`}
          aria-pressed={mood === null}
          onClick={() => setMood(null)}
        >
          不选
        </button>
        {MOODS.map((m) => (
          <button
            key={m.key}
            type="button"
            className={`mood-chip${mood === m.key ? ' on' : ''}`}
            aria-pressed={mood === m.key}
            onClick={() => setMood(m.key)}
          >
            {m.emoji} {m.label}
          </button>
        ))}
      </div>

      <div className="card-color-row" role="group" aria-label="卡片颜色">
        {CARD_COLORS.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`card-color-dot${cardColor === c.key ? ' on' : ''}`}
            data-color={c.key}
            aria-pressed={cardColor === c.key}
            aria-label={c.label}
            title={c.label}
            onClick={() => setCardColor(c.key)}
          />
        ))}
      </div>
      {error && <p className="error-text">{error}</p>}
      {uploadHint && <p className="status-text">{uploadHint}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? '发布中…' : '发布'}
      </button>
    </form>
  )
}