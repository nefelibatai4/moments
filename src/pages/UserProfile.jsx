import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import ImageLightbox from '../components/ImageLightbox'

/**
 * 个人名片页（/user/:userId）。
 *
 * 使用者 2026-09-22 的要求：私聊界面里的用户信息要能点开看「简单个人介绍」，
 * 页面上要有**头像 / ID / 个性签名**。
 *   * 「ID」选定为**昵称**（问过使用者）——系统 uuid / 邮箱对人没有意义，
 *     而且邮箱属于隐私，不该在圈内互相暴露。
 *   * 签名列 `profiles.signature` 由 db-backups/20260923_profile_signature_and_guard.sql 添加。
 *
 * 点自己的头像也走这里（同一条路径），不做特判：能看到自己的名片是符合直觉的，
 * 而且【我】里已经有各处的编辑入口。
 */
export default function UserProfile() {
  const { userId } = useParams()
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lightboxSrc, setLightboxSrc] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      // 用 maybeSingle() 而不是 single()：`single()` 把"0 行"和"请求失败"
      // 都当成 error，两者混在一起会显示错误的提示（详见 PITFALLS #47）
      const { data, error: err } = await supabase
        .from('profiles')
        .select('id, nickname, avatar_url, signature, created_at')
        .eq('id', userId)
        .maybeSingle()
      if (cancelled) return
      if (err) setError(err.message)
      else if (!data) setError('找不到这个用户')
      else setProfile(data)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [userId])

  if (loading) return <p className="status-text">加载中…</p>
  if (error) return (
    <div className="user-card-page">
      <p className="error-text">{error}</p>
      <Link to="/chat" className="user-card-back">← 返回私聊</Link>
    </div>
  )

  const initial = (profile.nickname ?? '').slice(0, 1)

  return (
    <div className="user-card-page">
      <button type="button" className="user-card-avatar" onClick={() => profile.avatar_url && setLightboxSrc(profile.avatar_url)}
        aria-label={profile.avatar_url ? '查看头像大图' : '没有头像'}>
        {profile.avatar_url ? <img src={profile.avatar_url} alt="" /> : initial}
      </button>

      <h2 className="user-card-name">{profile.nickname}</h2>
      <p className="user-card-id">ID：{profile.nickname}</p>
      <p className="user-card-signature">
        {profile.signature ? profile.signature : <span className="user-card-empty">这个人很懒，还没有写个性签名</span>}
      </p>

      <div className="user-card-actions">
        <Link className="user-card-chat-btn" to={`/chat/${profile.id}`}>发私聊</Link>
        <Link className="user-card-back" to="/chat">← 返回私聊</Link>
      </div>

      <ImageLightbox src={lightboxSrc} alt={`${profile.nickname} 的头像`} onClose={() => setLightboxSrc(null)} />
    </div>
  )
}
