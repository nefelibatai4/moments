import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'

/**
 * 「忘记密码」→ 发一封重置邮件（2026-10-14，功能攒单 ①）。
 *
 * 背景：账号本来就用邮箱做标识，但一直没有找回入口。忘密码时只有两条路：
 *   ① 社交恢复（恢复**内容**：让对方把恢复包裹交付给你）；
 *   ② 管理端改密码（恢复**登录**）。
 * 这一页补的是自助的 ② —— 也就是"第二条登录通道"。
 *
 * ⚠️ 必须先说清（页面上也写了）：**邮箱只能恢复登录，恢复不了历史内容**。
 *    内容是用登录密码推出来的钥匙解开的，而服务器上从来没有这把钥匙 ——
 *    所以"邮箱在我手里"并不等于"内容能读出来"。重置完登录之后，
 *    如果这台设备的钥匙已经没了，还需要 TA 交付一次恢复包裹（现有机制）。
 *
 * ⚠️ 这里**不能**告诉使用者"这个邮箱存不存在"（那等于一个免费的账号探测器）。
 *    所以无论服务器返回什么，界面都是同一句"如果这个邮箱在系统里，邮件已经发出"。
 */
export default function Forgot() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    const mail = email.trim()
    if (!mail) return
    setBusy(true)
    setError(null)
    try {
      // 邮件里的链接要跳回**应用自己**（带上恢复令牌）。
      // ⚠️ 这个地址必须在 Supabase 后台的 Redirect URLs 白名单里，否则会被换成 Site URL
      //    （本项目实测：Site URL 是 http://localhost:3000 → 链接点开是空的，见 PITFALLS #96/#97）
      const { error: err } = await supabase.auth.resetPasswordForEmail(mail, {
        redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}`,
      })
      if (err) throw err
      setSent(true)
    } catch (err) {
      // ⚠️ Supabase 自带的发信有**很低的频率限制**（默认每小时只允许少量邮件）。
      //    撞上时必须说人话，否则使用者看到的是 "email rate limit exceeded" 这种英文报错，
      //    只会反复点"再发一次"，越点越被限。
      const raw = String(err?.message || '')
      const limited = err?.status === 429 || /rate limit/i.test(raw)
      setError(limited
        ? '邮件发得太频繁了（服务器每小时只允许少量）。等一会儿再试，或者直接让 TA 帮你把密码改掉。'
        : (raw || '发送失败，稍后再试'))
    }
    setBusy(false)
  }

  if (sent) {
    return (
      <div className="auth-page">
        <h2>邮件已发出</h2>
        <p className="status-text">
          如果这个邮箱在系统里，你会在几分钟内收到一封重置邮件，点里面的链接设置新密码。
        </p>
        <p className="status-text forgot-caveat">
          提醒一句：邮箱只能帮你把<strong>登录</strong>找回来。历史内容是用登录密码解开的，
          服务器上没有这把钥匙 —— 如果这台设备上的内容也打不开了，还需要 TA 帮忙取回一次。
        </p>
        <p className="auth-switch-link">
          没收到？<Link to="/forgot">再发一次</Link> · <Link to="/login">回登录</Link>
        </p>
      </div>
    )
  }

  return (
    <form className="login-form" onSubmit={handleSubmit}>
      <h2>找回密码</h2>
      <p className="status-text">输入账号邮箱，我们给你发一封设置新密码的邮件。</p>
      <input
        type="email"
        placeholder="邮箱"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      {error && <p className="error-text">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? '发送中…' : '发送重置邮件'}</button>
      <p className="auth-switch-link">
        想起来了？<Link to="/login">回登录</Link>
      </p>
    </form>
  )
}
