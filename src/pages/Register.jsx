import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { cacheDekOnDevice, deriveAuthPassword, noteLoginSecrets, unlockWithPassword } from '../lib/crypto'
import { useAccess } from '../lib/AuthContext'

/**
 * 注册流程（2026-09-30 起：邀请码 → **注册口令**）。
 *
 * 两道门，缺一不可：
 *   1. **建号那一步**：口令随 signUp 一起送上去（放在 user_metadata 里），
 *      服务端 Auth Hook「Before User Created」拿它比对 —— 不对就压根建不出账号。
 *      ⚠️ 这个 Hook 需要管理员在 Supabase Dashboard 里手动开启一次；
 *         没开的时候这一步不校验（见 2）。
 *   2. **激活那一步**：建号后立刻调 claim_passphrase()（SECURITY DEFINER）认领口令、
 *      把 profiles.approved 置为 true —— 读内容的所有策略都要求 is_approved()。
 *      所以即使 Hook 没开，建出来的号也读不到任何一行。
 *
 * 为什么两步都要：Hook 是"能不能建号"，claim 是"能不能看内容"。两者解耦之后，
 * 任何一边被关掉/回退，门禁都不会漏（这也是 PITFALLS 里记的老教训：
 * 不要把安全性押在单一环节上）。
 */
export default function Register() {
  const navigate = useNavigate()
  const { refreshApproval } = useAccess()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    try {
      const gate = passphrase.trim()
      if (!gate) throw new Error('请输入注册口令')

      // 1. 建号（口令一并送上去，交给服务端 Auth Hook 判定）
      // 注册时就用**派生值**当密码：服务器永远看不到真实密码（老账号由登录时的静默迁移处理）
      const authPassword = await deriveAuthPassword(password, email)
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email,
        password: authPassword,
        options: { data: { gate_passphrase: gate } },
      })
      if (signUpError) throw signUpError
      if (!signUpData.session) throw new Error('注册失败，请重试')

      // 2. 激活：服务端原子比对口令并把 approved 置为 true
      //    （IP 由服务端从请求头取，失败次数多了会被限速，见 app_settings / auth_attempts）
      const { data: claimed, error: claimError } = await supabase.rpc('claim_passphrase', {
        p_passphrase: gate,
      })
      if (claimError) throw claimError

      if (!claimed) {
        // 账号已建好但口令没对上（例如 Hook 没开、或刚好被换掉）：去激活页重新输，不要重复建号
        navigate('/activate', { replace: true, state: { reason: '注册口令不正确' } })
        return
      }

      // 2.6 无感解锁：用同一个密码派生主密钥并生成数据密钥（服务器上只存被包住的密文）
      try {
        noteLoginSecrets({ password, credential: authPassword, email })
        const res = await unlockWithPassword(signUpData.user.id, password, email)
        if (res.ok) await cacheDekOnDevice(signUpData.user.id)
      } catch (err) {
        console.warn('[crypto] init failed (non-blocking):', err?.message)
      }

      // 3. 把口令从本地会话/user_metadata 里清掉。数据库那边有 BEFORE 触发器兜底
      //    （GoTrue 会把 options.data 原样存进 auth.users.raw_user_meta_data），
      //    这里顺手把浏览器缓存里的那一份也擦掉。失败也无所谓，不影响注册结果。
      void supabase.auth.updateUser({ data: { gate_passphrase: null } })

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
        type="password"
        placeholder="注册口令"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        maxLength={64}
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
