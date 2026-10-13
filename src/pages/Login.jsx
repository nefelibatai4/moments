import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { ensureIdentity, syncIdentityWithPassword } from '../lib/e2e'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError('登录失败，请检查邮箱和密码')
      setSubmitting(false)
      return
    }
    // 「钥匙跟着账号走」：登录时手里有密码，顺便把加密钥匙同步好 ——
    //   · 这台设备没有钥匙：用密码解开服务器上那份（**不用再抄恢复码**）
    //   · 这台设备有钥匙：确认服务器上那份是当前密码包的，换了密码就重包
    // 失败不影响登录（最坏情况就是回到"用恢复码恢复"）。
    try {
      const uid = data?.user?.id
      // ① 先确保本机有钥匙（服务器上还没有公钥时才生成；已有公钥但本机没钥匙 → 不生成，留给恢复）
      await ensureIdentity(uid)
      // ② 再用密码同步：本机有钥匙 → 用密码存/重包一份；本机没有但有密码包裹 → 用密码解开接上
      const res = await syncIdentityWithPassword(uid, password)
      if (res.reason) console.warn('[e2e] 密码同步钥匙未完成:', res.reason)
    } catch (err) {
      console.warn('[e2e] 密码同步钥匙异常:', err?.message)
    }
    navigate(location.state?.from?.pathname ?? '/', { replace: true })
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <h2>登录</h2>
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
        required
      />
      {error && <p className="error-text">{error}</p>}
      <button type="submit" disabled={submitting}>登录</button>
      <p className="auth-switch-link">
        没有账号？<Link to="/register">去注册</Link>
      </p>
    </form>
  )
}
