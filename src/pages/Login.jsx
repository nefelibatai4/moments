import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { cacheDekOnDevice, deriveAuthPassword, unlockWithPassword } from '../lib/crypto'

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
    // 发给服务器的"密码"是**派生值**（服务器永远看不到真实密码，也就派不出加密钥匙）。
    // ⚠️ 兼容老账号：库里的密码可能还是原始密码 —— 先试派生值，失败再试原始密码，
    //    原始密码成功说明是老账号 → 静默把它迁移成派生值（用户完全无感）。
    let data = null
    let error = null
    try {
      const derived = await deriveAuthPassword(password, email)
      ;({ data, error } = await supabase.auth.signInWithPassword({ email, password: derived }))
      if (error) {
        const legacy = await supabase.auth.signInWithPassword({ email, password })
        if (!legacy.error) {
          data = legacy.data
          error = null
          // 迁移：把登录密码换成派生值（需要会话，刚刚登录成功所以有）
          supabase.auth.updateUser({ password: derived }).catch(() => {})
        }
      }
    } catch (err) {
      error = { message: err?.message || '登录失败' }
    }
    if (error) {
      setError('登录失败，请检查邮箱和密码')
      setSubmitting(false)
      return
    }
    // 无感解锁：用同一个密码在本地派生主密钥、解开数据密钥（首次登录会顺手生成）
    try {
      const uid = data?.user?.id
      const res = await unlockWithPassword(uid, password, email)
      if (res.ok) await cacheDekOnDevice(uid)
      else if (res.reason) console.warn('[crypto] unlock failed:', res.reason)
    } catch (err) {
      console.warn('[crypto] unlock error:', err?.message)
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
