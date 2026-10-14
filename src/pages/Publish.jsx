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
import { uploadEncryptedImage } from '../lib/imageCrypto'

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

  async function handleSubmit(e) {
    e.preventDefault()
    if (!content.trim() && files.length === 0) {
      setError('请输入文字或选择图片')
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
      setUploadHint(null)

      // 回写：图片定位串 + 正文密文（图片的密文钥匙就是这条 CEK，不需要额外记录）
      const patch = { images: imageUrls.length > 0 ? imageUrls : null }
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
      <textarea
        placeholder="分享点什么…"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={5}
        maxLength={1000}
      />
      <input
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => setFiles(Array.from(e.target.files))}
      />
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