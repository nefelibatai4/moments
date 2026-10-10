import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAccess } from '../lib/AuthContext'

/**
 * 未激活账号的落地页。
 *
 * 背景：真正的门禁做在服务端 —— 新账号 profiles.approved = false，
 * 所有读取策略都要求 is_approved()，因此未激活账号登录后读不到任何内容。
 * 这里让用户凭**注册口令**激活（口令由管理员在 Supabase 里设置、【我】页面里更换）。
 *
 * 口径变化（2026-09-30）：邀请码 → 注册口令。建号那一步也由 Auth Hook 校验口令，
 * 所以走到这一页的通常只剩两种人：Hook 还没开启时建号的，或者口令刚好被换掉时注册的。
 */
export default function Activate() {
  const { session, approved, refreshApproval } = useAccess()
  const navigate = useNavigate()
  const location = useLocation()
  const [passphrase, setPassphrase] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(location.state?.reason ?? null)

  // 兜底：**已经激活的账号不该待在这一页**。
  //
  // 之前这里没有任何出口 —— 只要因为一次查询失败被误判成"未激活"弹过来，
  // 就算后台随后查清了你其实已激活，页面也不会动，用户除了手动刷新没别的办法。
  // 现在一旦确认已激活就自动回到原来想去的页面。
  useEffect(() => {
    if (approved === true) {
      navigate(location.state?.from?.pathname ?? '/', { replace: true })
    }
  }, [approved, navigate, location.state])

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = passphrase.trim()
    if (!trimmed) {
      setError('请输入注册口令')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const { data: claimed, error: claimError } = await supabase.rpc('claim_passphrase', {
        p_passphrase: trimmed,
      })
      if (claimError) throw claimError
      if (!claimed) throw new Error('口令不正确，请向站长索取当前口令（也可能是输错太多次，被限速了）')

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
        本站为私密圈，需要注册口令才能查看内容。
        <br />
        当前登录账号：{session?.user?.email}
      </p>
      <input
        type="password"
        placeholder="注册口令"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
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
