import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAccess } from '../lib/AuthContext'

/**
 * 注册流程（邀请码走服务端 RPC，客户端不再直接读 invite_codes 表）。
 *
 * 旧实现有两个问题：
 *   1. 直接 select invite_codes，依赖 invite_codes_public_read USING(true)，
 *      导致任何未登录者都能枚举全部邀请码；
 *   2. 是"先建号、后认领"，认领失败会留下一个已经能用（旧策略下）的僵尸账号。
 *
 * 现在：
 *   validate_invite_code（匿名可调，只回答"你给的这一个码是否可用"，无法枚举）
 *     → signUp
 *     → claim_invite_code（服务端行锁下原子认领 + 激活账号）
 *   若最后一步失败（码刚好被别人抢走），账号已建但未激活，跳 /activate 换码即可，
 *   不会再出现"有账号就能看内容"的情况。
 */
export default function Register() {
  const navigate = useNavigate()
  const { refreshApproval } = useAccess()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    try {
      const code = inviteCode.trim()

      // 1. 预检：不泄露除"这一个码是否可用"以外的任何信息
      const { data: valid, error: validateError } = await supabase.rpc('validate_invite_code', {
        p_code: code,
      })
      if (validateError) throw validateError
      if (!valid) throw new Error('邀请码无效或已被使用')

      // 2. 建号
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
      })
      if (signUpError) throw signUpError
      if (!signUpData.session) throw new Error('注册失败，请重试')

      // 3. 原子认领邀请码并激活（IP 由服务端从请求头记录）
      const { data: claimed, error: claimError } = await supabase.rpc('claim_invite_code', {
        p_code: code,
      })
      if (claimError) throw claimError

      if (!claimed) {
        // 账号已建好但没抢到这个码：去激活页换一个码，不要停在注册页重复建号
        navigate('/activate', { replace: true, state: { reason: '邀请码刚被使用，请向邀请人索取新的邀请码' } })
        return
      }

      // 必须等激活状态刷新完再跳转：AuthContext 可能在认领之前就已经读到
      // approved=false 并缓存住了，否则 RequireAuth 会把刚注册成功的用户弹回 /activate
      await refreshApproval()
      navigate('/')
    } catch (err) {
      setError(err.message)
      setSubmitting(false)
    }
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <h2>注册</h2>
      <input
        type="email"
        placeholder="邮箱"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <input
        type="password"
        placeholder="密码"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        minLength={6}
        required
      />
      <input
        type="text"
        placeholder="邀请码"
        value={inviteCode}
        onChange={(e) => setInviteCode(e.target.value)}
        required
      />
      {error && <p className="error-text">{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? '注册中…' : '注册'}
      </button>
      <p className="auth-switch-link">
        已有账号？<Link to="/login">去登录</Link>
      </p>
    </form>
  )
}
