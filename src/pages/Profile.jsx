import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { getTheme, setTheme } from '../lib/theme'

export default function Profile() {
  const session = useAuth()
  const navigate = useNavigate()
  const [nickname, setNickname] = useState('')
  const [avatarUrl, setAvatarUrl] = useState(null)
  const [loading, setLoading] = useState(true)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [savingNickname, setSavingNickname] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)
  const [darkMode, setDarkMode] = useState(getTheme() === 'dark')
  const [inviteCode, setInviteCode] = useState(null)
  const [generatingInvite, setGeneratingInvite] = useState(false)
  const [error, setError] = useState(null)
  const [message, setMessage] = useState(null)

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('profiles')
        .select('nickname, avatar_url')
        .eq('id', session.user.id)
        .single()
      if (!error && data) {
        setNickname(data.nickname)
        setAvatarUrl(data.avatar_url)
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
      const path = `${session.user.id}/avatar`
      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, file, { upsert: true, contentType: file.type })
      if (uploadError) throw uploadError

      const { data: publicUrlData } = supabase.storage.from('avatars').getPublicUrl(path)
      const freshUrl = `${publicUrlData.publicUrl}?t=${Date.now()}`

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

  if (loading) return <p className="status-text">加载中…</p>

  return (
    <div className="profile-page">
      <h2>我</h2>

      <div className="profile-avatar-section">
        <span className="profile-avatar">
          {avatarUrl ? <img src={avatarUrl} alt="" /> : nickname.slice(0, 1)}
        </span>
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
          maxLength={30}
          required
        />
        <button type="submit" disabled={savingNickname}>
          {savingNickname ? '保存中…' : '保存昵称'}
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

      <div className="invite-section">
        <button type="button" onClick={handleGenerateInvite} disabled={generatingInvite}>
          {generatingInvite ? '生成中…' : '生成邀请码'}
        </button>
        {inviteCode && <p className="invite-code-display">邀请码：<strong>{inviteCode}</strong></p>}
      </div>

      <div className="theme-section">
        <div className="theme-toggle-row">
          <span>{darkMode ? '🌙 深色模式' : '☀️ 浅色模式'}</span>
          <label className="theme-switch" onClick={handleThemeToggle}>
            <input type="checkbox" checked={!darkMode} readOnly />
            <span className="theme-slider" />
          </label>
        </div>
      </div>

      <button type="button" className="sign-out-button" onClick={handleSignOut}>退出登录</button>
    </div>
  )
}
