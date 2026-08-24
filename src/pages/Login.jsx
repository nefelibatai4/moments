import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError('登录失败，请检查邮箱和密码')
    setSubmitting(false)
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
