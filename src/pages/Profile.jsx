import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { getTheme, setTheme } from '../lib/theme'
import { compressImage } from '../lib/compressImage'
import ImageLightbox from '../components/ImageLightbox'
import PanelBackgroundSettings from '../components/PanelBackgroundSettings'
import AdminPanel from '../components/AdminPanel'
import LocationConsent from '../components/LocationConsent'
import SignedImage from '../components/SignedImage'
import { objectLocator, invalidateSignedUrl, resolveSignedUrl } from '../lib/signedUrls'
import { fulfillRecoveryRequest, onUnlockChange, recoveryStatus, unlockStateVersion } from '../lib/crypto'
import UsageCard from '../components/UsageCard'

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
  // 玩偶形象：与头像各放各的（使用者 2026-10-14：玩偶是玩偶，头像是头像）
  const [doll, setDoll] = useState(null)

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('profiles')
        .select('nickname, avatar_url, signature, doll')
        .eq('id', session.user.id)
        .single()
      if (!error && data) {
        setNickname(data.nickname)
        setAvatarUrl(data.avatar_url)
        setSignature(data.signature ?? '')
        setDoll(data.doll ?? null)
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

  // 社交恢复（阶段 0b）：正常情况下这个区块**什么都不显示**，只有在下面两种罕见情况下才出现
  //   ① 对方忘过密码、在等我帮忙交付 → 一个按钮
  //   ② 有人取过我的恢复数据（审计）→ 一行字
  const [recovery, setRecovery] = useState({ outgoing: [], access: [], waiting: false })
  const [recoveryMsg, setRecoveryMsg] = useState(null)
  const [helping, setHelping] = useState(false)

  // ⚠️ 必须跟着"解锁状态"重查：这一页可能在**设备缓存解锁完成之前**就挂载了，
  //    那一刻还不知道当前账号是谁，查询会返回空、而且再也不会重试（实测踩到：
  //    对方的"帮 TA 取回"入口永远不出现）。
  const [unlockV, setUnlockV] = useState(() => unlockStateVersion())
  useEffect(() => onUnlockChange(setUnlockV), [])
  useEffect(() => {
    const uid = session?.user?.id
    if (!uid) return undefined
    let cancelled = false
    recoveryStatus()
      .then((st) => { if (!cancelled) setRecovery(st) })
      .catch((err) => { console.warn('[recovery] 读取恢复状态失败:', err?.message) })
    return () => { cancelled = true }
  }, [session?.user?.id, unlockV])

  async function handleHelpRecover(req) {
    setHelping(true)
    setRecoveryMsg(null)
    const res = await fulfillRecoveryRequest(req.id, req.ownerId)
    if (res.ok) {
      setRecovery((prev) => ({ ...prev, outgoing: prev.outgoing.filter((r) => r.id !== req.id) }))
      setRecoveryMsg(`已经交给 ${req.ownerName} 了：让 TA 打开一次 Moments，历史内容就会自己回去。`)
    } else {
      setRecoveryMsg(`没能帮上：${res.reason ?? '请稍后再试'}`)
    }
    setHelping(false)
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
    // 登录密码同样存派生值；同时把数据密钥用新密码重包一份（**无需旧密码**：
    // 内存里已经解锁着 DEK）→ 历史照旧可读，用户无感
    const { deriveAuthPassword, rekeyWithUnlockedKeys, cacheDekOnDevice } = await import('../lib/crypto')
    const authPassword = await deriveAuthPassword(newPassword, session.user.email)
    const { error } = await supabase.auth.updateUser({ password: authPassword })
    if (!error) {
      try {
        const rk = await rekeyWithUnlockedKeys(session.user.id, newPassword, session.user.email)
        if (!rk.ok) console.warn('[crypto] rewrap failed:', rk.reason)
        else await cacheDekOnDevice(session.user.id)
      } catch (err) {
        console.warn('[crypto] rewrap error:', err?.message)
      }
    }
    if (error) {
      setError(error.message)
    } else {
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
          minLength={10}
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

      {/* 社交恢复：正常什么都不显示 */}
      {(recovery.outgoing.length > 0 || recovery.waiting || recovery.access.length > 0) && (
        <section className="recovery-section">
          {recovery.waiting && (
            <p className="status-text">
              历史内容还在等 TA 帮忙取回：让 TA 打开一次 Moments；TA 帮忙之后你再登录一次即可。
            </p>
          )}
          {recovery.outgoing.map((req) => (
            <div key={req.id} className="recovery-row">
              <span>{req.ownerName} 忘了密码，需要你帮 TA 把历史内容取回。</span>
              <button type="button" onClick={() => handleHelpRecover(req)} disabled={helping}>
                {helping ? '处理中…' : '帮 TA 取回'}
              </button>
            </div>
          ))}
          {recoveryMsg && <p className="success-text">{recoveryMsg}</p>}
          {recovery.access.length > 0 && (
            <p className="status-text recovery-audit">
              有人取过你的恢复数据（用于忘密码时找回）：{new Date(recovery.access[0].at).toLocaleString('zh-CN')}
            </p>
          )}
        </section>
      )}

      {/* 玩偶形象：独立路由，玩偶库只在那里加载。
          ⚠️ 玩偶**不动头像**（使用者 2026-10-14 明确要求"玩偶是玩偶，头像是头像"），
             所以这里是"展示区"：捏好的玩偶在这儿单独亮相，头像还是他上传的那张。 */}
      <section className="doll-entry">
        {doll?.image && (
          <SignedImage
            bucket="avatars"
            stored={doll.image}
            className="doll-showcase"
            data-doll-image="1"
            alt="我的玩偶形象"
          />
        )}
        <div className="doll-entry-text">
          <strong>玩偶形象</strong>
          <p className="status-text">
            {doll?.image
              ? '这是你捏的玩偶，只在这里展示，不会替换头像。'
              : '捏一个小玩偶放在主页上：肤色、发型、眉型、穿搭都能自己选（头像不受影响）。'}
          </p>
        </div>
        <Link to="/doll" className="doll-entry-btn">{doll?.image ? '改一改' : '去捏一个'}</Link>
      </section>

      {/* 精确位置（可选，默认关闭） */}
      <LocationConsent />

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

      <UsageCard />

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
