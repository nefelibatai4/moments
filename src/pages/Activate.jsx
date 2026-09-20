import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAccess } from '../lib/AuthContext'

/**
 * 未激活账号的落地页。
 *
 * 背景：auth.signUp 本身不校验邀请码，所以只要有人拿到公开的 anon key
 * 就能注册出账号。真正的门禁做在服务端：新账号 profiles.approved = false，
 * 所有读取策略都要求 is_approved()，因此未激活账号登录后读不到任何内容。
 * 这里让用户凭邀请码激活。
 */
export default function Activate() {
  const { session, refreshApproval } = useAccess()
  const navigate = useNavigate()
  const location = useLocation()
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(location.state?.reason ?? null)

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = code.trim()
    if (!trimmed) {
      setError('请输入邀请码')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const { data: claimed, error: claimError } = await supabase.rpc('claim_invite_code', {
        p_code: trimmed,
      })
      if (claimError) throw claimError
      if (!claimed) throw new Error('邀请码无效或已被使用，请向邀请人索取新的邀请码')

      // 等激活状态刷新完再跳转，否则会被 RequireAuth 弹回来
      await refreshApproval()
      navigate(location.state?.from?.pathname ?? '/', { replace: true })
    } catch (err) {
      setError(err.message)
      setSubmitting(false)
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login', { replace: true })
  }

  return (
    <form className="login-form activate-form" onSubmit={handleSubmit}>
      <h2>账号未激活</h2>
      <p className="activate-hint">
        本站为邀请制私密圈，需要邀请码才能查看内容。
        <br />
        当前登录账号：{session?.user?.email}
      </p>
      <input
        type="text"
        placeholder="邀请码"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        maxLength={64}
        autoFocus
      />
      {error && <p className="error-text">{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? '激活中…' : '激活账号'}
      </button>
      <button type="button" className="ghost-button" onClick={handleSignOut}>
        退出登录
      </button>
    </form>
  )
}
