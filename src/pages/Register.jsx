import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'

async function fetchIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json')
    const data = await res.json()
    return data.ip
  } catch {
    return null
  }
}

export default function Register() {
  const navigate = useNavigate()
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
      const { data: invite, error: inviteError } = await supabase
        .from('invite_codes')
        .select('code, used_by')
        .eq('code', code)
        .maybeSingle()

      if (inviteError) throw inviteError
      if (!invite) throw new Error('邀请码不存在')
      if (invite.used_by) throw new Error('邀请码已被使用')

      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
      })
      if (signUpError) throw signUpError
      if (!signUpData.session) throw new Error('注册失败，请重试')

      const ip = await fetchIp()
      const { data: updated, error: updateError } = await supabase
        .from('invite_codes')
        .update({
          used_by: signUpData.user.id,
          used_at: new Date().toISOString(),
          registrant_ip: ip,
        })
        .eq('code', code)
        .is('used_by', null)
        .select()

      if (updateError) throw updateError
      if (!updated || updated.length === 0) {
        throw new Error('邀请码刚被使用，请联系邀请人获取新的邀请码')
      }

      navigate('/')
    } catch (err) {
      setError(err.message)
    } finally {
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
        已有账号？<Link to="/publish">去登录</Link>
      </p>
    </form>
  )
}
