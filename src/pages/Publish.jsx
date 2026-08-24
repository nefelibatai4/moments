import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import Login from './Login'

export default function Publish() {
  const session = useAuth()
  const navigate = useNavigate()
  const [content, setContent] = useState('')
  const [files, setFiles] = useState([])
  const [location, setLocation] = useState(null)
  const [locating, setLocating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [inviteCode, setInviteCode] = useState(null)
  const [generatingInvite, setGeneratingInvite] = useState(false)

  if (session === undefined) return <p className="status-text">加载中…</p>
  if (session === null) return <Login />

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
      const imageUrls = []
      for (const file of files) {
        const path = `${session.user.id}/${Date.now()}-${file.name}`
        const { error: uploadError } = await supabase.storage
          .from('moment-images')
          .upload(path, file)
        if (uploadError) throw uploadError

        const { data: publicUrlData } = supabase.storage
          .from('moment-images')
          .getPublicUrl(path)
        imageUrls.push(publicUrlData.publicUrl)
      }

      const { error: insertError } = await supabase.from('moments').insert({
        content: content.trim() || null,
        images: imageUrls.length > 0 ? imageUrls : null,
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
        user_id: session.user.id,
      })
      if (insertError) throw insertError

      navigate('/')
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleGenerateInvite() {
    setGeneratingInvite(true)
    setError(null)
    try {
      const code = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
      const { error: insertError } = await supabase
        .from('invite_codes')
        .insert({ code, created_by: session.user.id })
      if (insertError) throw insertError
      setInviteCode(code)
    } catch (err) {
      setError(err.message)
    } finally {
      setGeneratingInvite(false)
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
      {error && <p className="error-text">{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? '发布中…' : '发布'}
      </button>

      <div className="invite-section">
        <button type="button" onClick={handleGenerateInvite} disabled={generatingInvite}>
          {generatingInvite ? '生成中…' : '生成邀请码'}
        </button>
        {inviteCode && <p className="invite-code-display">邀请码：<strong>{inviteCode}</strong></p>}
      </div>
    </form>
  )
}
