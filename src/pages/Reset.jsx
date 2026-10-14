import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { useAccess } from '../lib/AuthContext'

/**
 * 设置新密码（邮件里的重置链接落回这里，功能攒单 ①，2026-10-14）。
 *
 * 到达这里的两种方式：
 *   ① 邮件链接 → 应用根地址带上 `#access_token=…&type=recovery` → supabase-js 解析后
 *      触发 `PASSWORD_RECOVERY` 事件 → AuthContext 把它翻出来 → 本页浮出（见 App.jsx）；
 *   ② 直接打开 /reset（链接过期/已用过）→ 本页给出"重新申请"的出口。
 *
 * 这一页做两件事，顺序很重要：
 *   1. 把**登录**恢复：认证用的值同样是派生值（邮箱参与派生）→ `updateUser({ password })`；
 *   2. 把**内容**尽量一起救回来：如果这台设备上还解锁着（内存里有钥匙），就用新密码重包一份
 *      —— 历史照旧可读，使用者完全无感；如果这台设备上什么都没有（换了手机 / 清过数据），
 *      那就只能等 TA 交付恢复包裹，页面上把这句话说清楚，并顺手挂出请求。
 *
 * ⚠️ 与改密码（【我】里）的区别：那里一定还解锁着，所以永远能重包；
 *    这里是"忘密码"进来的，可能这台设备上什么都没有 —— 两条路都要能走通。
 */
export default function Reset() {
  const { session, clearRecovering } = useAccess()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)   // { contentBack: boolean }

  const email = session?.user?.email ?? null

  if (!session || !email) {
    return (
      <div className="auth-page">
        <h2>链接已失效</h2>
        <p className="status-text">
          这个重置链接已经用过、或者过期了（链接只能用一次，且有时效）。
        </p>
        <p className="auth-switch-link">
          <Link to="/forgot">重新申请一封</Link> · <Link to="/login">回登录</Link>
        </p>
      </div>
    )
  }

  if (done) {
    return (
      <div className="auth-page">
        <h2>新密码已生效</h2>
        <p className="status-text">下次就用这个密码登录。</p>
        {done.contentBack ? (
          <p className="status-text">这台设备上的历史内容照旧可以看，不需要再做别的。</p>
        ) : (
          <p className="status-text forgot-caveat">
            但这台设备上还看不到历史内容 —— 那些内容是用旧密码解开的，服务器上没有钥匙。
            在【我】里让 TA 帮忙取回一次，之后重新登录即可（不影响新发的消息）。
          </p>
        )}
        <button type="button" className="auth-done-btn" onClick={() => navigate('/', { replace: true })}>
          开始使用
        </button>
      </div>
    )
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (busy) return
    if (password.length < 8) { setError('密码至少 8 位'); return }
    if (password !== confirm) { setError('两次输入的密码不一致'); return }
    setBusy(true)
    setError(null)
    const uid = session.user.id
    try {
      const {
        cacheDekOnDevice, createRecoveryRequest, deriveAuthPassword, isUnlocked,
        noteLoginSecrets, rekeyWithUnlockedKeys, unlockWithPassword, applyRecoveryHandover,
      } = await import('../lib/crypto')

      // 1) 恢复登录：认证值用派生值（邮箱参与派生，所以必须用当前邮箱重算）
      const authPassword = await deriveAuthPassword(password, email)
      const { error: err } = await supabase.auth.updateUser({ password: authPassword })
      if (err) throw err
      noteLoginSecrets({ password, credential: authPassword, email })

      // 2) 内容：设备上还解锁着 → 用新密码重包一份（钥匙本身不变，历史照旧可读）
      let contentBack = false
      if (isUnlocked()) {
        const rk = await rekeyWithUnlockedKeys(uid, password, email)
        if (rk.ok) {
          contentBack = true
          await cacheDekOnDevice(uid)
        } else {
          console.warn('[reset] 重包失败:', rk.reason)
        }
      }
      // 3) 重新装上（重包成功时这一步会成功；没重包时它会失败，但会把"当前账号/密码"记下，
      //    下面挂恢复请求要用这两个值）
      const un = await unlockWithPassword(uid, password, email)
      if (un.ok) contentBack = true
      if (!contentBack) {
        // 这台设备上什么都没有：走既有的"请对方交付恢复包裹"这条路
        try {
          const handed = await applyRecoveryHandover(email)
          if (handed?.ok) {
            contentBack = true
            await cacheDekOnDevice(uid)
          } else {
            await createRecoveryRequest()
          }
        } catch (e2) {
          console.warn('[reset] 恢复请求失败:', e2?.message)
        }
      }
      setDone({ contentBack })
      clearRecovering()
    } catch (err) {
      setError(err?.message || '设置失败，请重新申请一封邮件')
    }
    setBusy(false)
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <h2>设置新密码</h2>
      <p className="status-text">
        给 <strong>{email}</strong> 设置一个新密码。设置完成后就用它登录。
      </p>
      <input
        type="password"
        placeholder="新密码（至少 8 位）"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <input
        type="password"
        placeholder="再输一次"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        required
      />
      {error && <p className="error-text">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? '设置中…' : '设置新密码'}</button>
      <p className="auth-switch-link">
        <Link to="/login">回登录</Link>
      </p>
    </form>
  )
}
