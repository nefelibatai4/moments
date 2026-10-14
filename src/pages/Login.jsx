import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import {
  applyRecoveryHandover, cacheDekOnDevice, createRecoveryRequest, deriveAuthPassword,
  noteLoginSecrets, unlockWithPassword,
} from '../lib/crypto'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  // 忘密码这条罕见路径的提示（正常情况下永远是 false，界面上什么都看不到）
  const [recoveryHint, setRecoveryHint] = useState(null)
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
    let derived = null
    try {
      derived = await deriveAuthPassword(password, email)
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
    let unlocked = false
    try {
      const uid = data?.user?.id
      // 恢复包裹里存的是**派生值**（不是用户原文密码）：迁移之后它就是库里的认证值，
      // 既能用来登录、又不等于用户可能在别处复用的那个密码。
      noteLoginSecrets({ password, credential: derived, email })
      const res = await unlockWithPassword(uid, password, email)
      if (res.ok) {
        unlocked = true
        await cacheDekOnDevice(uid)
      } else if (res.reason) {
        console.warn('[crypto] unlock failed:', res.reason)
      }
    } catch (err) {
      console.warn('[crypto] unlock error:', err?.message)
    }
    // 认证过了但钥匙解不开 = 这套钥匙不是这个密码包的（忘过密码）。两条路：
    //   ① 对方已经把恢复包裹交付了 → 立刻装回来（全自动、不打扰）
    //   ② 还没交付 → 挂出请求，并给一句人话提示
    if (!unlocked) {
      try {
        const done = await applyRecoveryHandover(email)
        // 恢复成功要把钥匙**写回设备缓存**，否则一刷新又变回"没钥匙"（实测踩到）
        if (done.ok && data?.user?.id) await cacheDekOnDevice(data.user.id)
        if (!done.ok) {
          const asked = await createRecoveryRequest()
          if (asked.ok) setRecoveryHint('还差一步：让 TA 打开一次 Moments；TA 帮忙之后你再登录一次，历史内容就回来了。')
          else if (asked.reason) {
            console.warn('[crypto] 挂恢复请求失败:', asked.reason)
            setRecoveryHint(`暂时没能请 TA 帮忙：${asked.reason}`)
          }
        }
      } catch (err) {
        console.warn('[crypto] recovery error:', err?.message)
      }
    }
    navigate(location.state?.from?.pathname ?? '/', { replace: true })
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <h2>登录</h2>
      {recoveryHint && <p className="status-text recovery-hint">{recoveryHint}</p>}
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
