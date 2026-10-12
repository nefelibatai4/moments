import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { getTheme, setTheme } from '../lib/theme'
import { compressImage } from '../lib/compressImage'
import ImageLightbox from '../components/ImageLightbox'
import PanelBackgroundSettings from '../components/PanelBackgroundSettings'
import AdminPanel from '../components/AdminPanel'
import SignedImage from '../components/SignedImage'
import { objectLocator, invalidateSignedUrl, resolveSignedUrl } from '../lib/signedUrls'

// 扩展只能在桌面版 Chrome 里安装：iOS 壳里没有「解压 + 装扩展」这个概念。
// 原生端不显示下载按钮，但也不让它静默消失（那样会被当成 bug），改显示一句该去哪做。
//
// 为什么用构建期开关而不是 Capacitor.isNativePlatform()：
// 那只是句平台判断，为此把 @capacitor/core 整个运行时（CapacitorHttp、
// CapacitorCookies、插件注册表…）打进【我】这个路由 chunk 不划算。
// VITE_APP_NATIVE 只在 build:app 里设置，是常量，无用分支会被直接摇掉。
const isNative = import.meta.env.VITE_APP_NATIVE === '1'

export default function Profile() {
  const session = useAuth()
  const navigate = useNavigate()
  const [nickname, setNickname] = useState('')
  const [avatarUrl, setAvatarUrl] = useState(null)
  const [loading, setLoading] = useState(true)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [savingNickname, setSavingNickname] = useState(false)
  const [signature, setSignature] = useState('')
  const [savingSignature, setSavingSignature] = useState(false)
  // 点头像看大图（灯箱），与聊天页共用同一个组件
  const [lightboxSrc, setLightboxSrc] = useState(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)
  const [darkMode, setDarkMode] = useState(getTheme() === 'dark')
  const [error, setError] = useState(null)
  const [message, setMessage] = useState(null)

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('profiles')
        .select('nickname, avatar_url, signature')
        .eq('id', session.user.id)
        .single()
      if (!error && data) {
        setNickname(data.nickname)
        setAvatarUrl(data.avatar_url)
        setSignature(data.signature ?? '')
      }
      setLoading(false)
    }
    load()
  }, [session.user.id])

  async function handleAvatarChange(e) {
    const file = e.target.files[0]
    if (!file) return
    setUploadingAvatar(true)
    setError(null)
    try {
      // 头像显示尺寸很小，压到 512 足够，也省 Storage
      const prepared = await compressImage(file, { maxDim: 512, quality: 0.85 })
      const path = `${session.user.id}/avatar`
      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, prepared, { upsert: true, contentType: prepared.type })
      if (uploadError) throw uploadError

      // ⚠️ 桶已私有：这里存的只是**定位串**（不能直接访问），渲染时统一换成签名地址。
      //    同一个路径（<uid>/avatar）内容变了 → 必须让签名缓存失效，否则会显示老头像。
      const freshUrl = `${objectLocator('avatars', path)}?t=${Date.now()}`
      invalidateSignedUrl('avatars', freshUrl)

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ avatar_url: freshUrl })
        .eq('id', session.user.id)
      if (updateError) throw updateError

      setAvatarUrl(freshUrl)
    } catch (err) {
      setError(err.message)
    } finally {
      setUploadingAvatar(false)
    }
  }

  async function handleSaveNickname(e) {
    e.preventDefault()
    setSavingNickname(true)
    setError(null)
    setMessage(null)
    const { error } = await supabase
      .from('profiles')
      .update({ nickname: nickname.trim() })
      .eq('id', session.user.id)
    if (error) setError(error.message)
    else setMessage('昵称已保存')
    setSavingNickname(false)
  }

  async function handleSaveSignature(e) {
    e.preventDefault()
    setSavingSignature(true)
    setError(null)
    setMessage(null)
    // 空字符串存成 null：语义是"没写签名"，而不是"签名是空串"，
    // 名片页要靠 null 决定显示占位文案
    const value = signature.trim()
    const { error } = await supabase
      .from('profiles')
      .update({ signature: value === '' ? null : value })
      .eq('id', session.user.id)
    if (error) setError(error.message)
    else setMessage('个性签名已保存')
    setSavingSignature(false)
  }

  async function handleChangePassword(e) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    if (newPassword.length < 6) {
      setError('密码至少 6 位')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }
    setChangingPassword(true)
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) setError(error.message)
    else {
      setMessage('密码已修改')
      setNewPassword('')
      setConfirmPassword('')
    }
    setChangingPassword(false)
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login')
  }

  function handleThemeToggle() {
    const next = !darkMode
    setDarkMode(next)
    setTheme(next ? 'dark' : 'light')
  }

  if (loading) return <p className="status-text">加载中…</p>

  return (
    <div className="profile-page">
      <h2>我</h2>


      <div className="profile-avatar-section">
        <button
          type="button"
          className="profile-avatar"
          onClick={async () => setLightboxSrc(await resolveSignedUrl('avatars', avatarUrl))}
          aria-label={avatarUrl ? '查看头像大图' : '还没有头像'}
        >
          {avatarUrl
            ? <SignedImage bucket="avatars" stored={avatarUrl} alt="" />
            : nickname.slice(0, 1)}
        </button>
        <label className="avatar-upload-label">
          {uploadingAvatar ? '上传中…' : '更换头像'}
          <input type="file" accept="image/*" onChange={handleAvatarChange} disabled={uploadingAvatar} hidden />
        </label>
      </div>

      <form className="profile-form" onSubmit={handleSaveNickname}>
        <label>昵称</label>
        <input
          type="text"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={12}   /* 与数据库约束一致：太长会让信息流卡片头折行（实测 14 字起折，见 db-backups/20260930_nickname_length.sql） */
          required
        />
        <button type="submit" disabled={savingNickname}>
          {savingNickname ? '保存中…' : '保存昵称'}
        </button>
      </form>

      <form className="profile-form" onSubmit={handleSaveSignature}>
        <label>个性签名</label>
        <textarea
          className="signature-input"
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
          maxLength={60}
          rows={2}
          placeholder="写一句介绍自己…（最多 60 字）"
        />
        <button type="submit" disabled={savingSignature}>
          {savingSignature ? '保存中…' : '保存签名'}
        </button>
      </form>

      <form className="profile-form" onSubmit={handleChangePassword}>
        <label>修改密码</label>
        <input
          type="password"
          placeholder="新密码"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          minLength={6}
        />
        <input
          type="password"
          placeholder="确认新密码"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          minLength={6}
        />
        <button type="submit" disabled={changingPassword}>
          {changingPassword ? '修改中…' : '修改密码'}
        </button>
      </form>

      {error && <p className="error-text">{error}</p>}
      {message && <p className="success-text">{message}</p>}

      <div className="share-section">
        <h3>给朋友用</h3>
        {isNative ? (
          <p className="share-hint">
            Chrome 扩展只能在电脑上安装。请在电脑上打开本网页，登录后在「我」里下载。
          </p>
        ) : (
          <>
            <p className="share-hint">
              下载扩展压缩包发给朋友。解压后打开 <code>chrome://extensions/</code>，开启右上角
              「开发者模式」，点「加载已解压的扩展程序」，选择解压出来的{' '}
              <code>moments-extension</code> 文件夹即可。注册还需要一个注册口令（在下面的「注册口令」里看）。
            </p>
            <a
              className="share-download"
              href={`${import.meta.env.BASE_URL}moments-extension.zip`}
              download="moments-extension.zip"
            >
              下载扩展（.zip）
            </a>
          </>
        )}
      </div>

      <PanelBackgroundSettings />

      {/* 成员管理：只有管理员会看到内容（服务端也会再校验一次） */}
      <AdminPanel />

      <div className="theme-section">
        <div className="theme-toggle-row">
          <span>{darkMode ? '🌙 深色模式' : '☀️ 浅色模式'}</span>
          <label className="theme-switch">
            <input type="checkbox" checked={!darkMode} onChange={handleThemeToggle} />
            <span className="theme-slider" />
          </label>
        </div>
      </div>

      <button type="button" className="sign-out-button" onClick={handleSignOut}>退出登录</button>

      <ImageLightbox src={lightboxSrc} alt="我的头像" onClose={() => setLightboxSrc(null)} />
    </div>
  )
}
