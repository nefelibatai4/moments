import { useEffect, useRef, useState } from 'react'
import { onUnlockRequested } from '../lib/unlockSignal'
import { supabase } from '../supabaseClient'
import { useAccess } from '../lib/AuthContext'
import {
  cacheDekOnDevice, deriveAuthPassword, hasLocalRecoveryEph, isUnlocked,
  noteLoginSecrets, onUnlockChange, unlockWithPassword,
} from '../lib/crypto'

/**
 * 「这台设备还没就绪」时的一次性提示（2026-10-14）。
 *
 * 为什么需要它：内容只在设备上加密/解开的，钥匙由**登录密码**推出来。
 * 一个人如果从来没在新版本里输过密码，这台设备上就没有任何钥匙材料 ——
 * 而**恢复一个旧会话时应用不会提示输密码**（只试着用本机缓存静默解开，
 * 缓存不存在就什么都不发生）。于是这种账号会一直停在"看得到界面、读不到内容"，
 * 而且是**静默**的：使用者完全不知道为什么，也没有任何入口可点。
 * 实测就发生在 2026-10-14：TA 用 10-12 留下的会话正常用应用（发了表情），
 * 但所有内容一直是明文，因为钥匙从来没建出来过。
 *
 * 所以这里补一个**温和、只出现一次**的入口：输一次密码即可，之后永不再问。
 * 刻意做成好几层"不打扰"：
 *   ① 只在"已登录 + 已激活 + 这台设备确实解不开 + 本机没有等着对方交付的恢复件"时出现；
 *   ② 宽限 2.5 秒再显示 —— 本机有缓存的账号会在这期间静默就绪，卡片根本不会闪出来；
 *   ③ 可点「稍后」，本次打开就不再打扰（下次打开还会问一次，否则永远就绪不了）；
 *   ④ 输错不会被计成"想新建一把"，**先向服务器核对密码**再动手。
 *
 * ⚠️ 界面上不能出现任何密码学词汇（`verify-crypto-foundation` 有源码级断言）：
 *    措辞只说"你们的内容 / 密码"，不说密钥、加密这类词。
 */
const GRACE_MS = 2500

export default function UnlockPrompt() {
  const { session, approved } = useAccess()
  const uid = session?.user?.id ?? null
  const email = session?.user?.email ?? null

  const [visible, setVisible] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  // 宽限期 + 就绪状态：本机有缓存的账号会在几百毫秒内静默就绪 → 卡片不显示。
  // 刻意**不在 effect 里同步 setState**：只用一个定时器去"武装"它，
  // 其余条件（已就绪 / 已点稍后 / 正在等对方交付）都在渲染时判断。
  useEffect(() => {
    if (!uid || approved !== true || dismissed) return
    if (isUnlocked() || hasLocalRecoveryEph(uid)) return
    const t = setTimeout(() => { if (!isUnlocked()) setVisible(true) }, GRACE_MS)
    // ⚠️ 回调收到的是"解锁版本号"，不是布尔值 —— 要自己再问一次 isUnlocked()
    const off = onUnlockChange(() => { if (isUnlocked()) setVisible(false) })
    return () => { clearTimeout(t); off() }
  }, [uid, approved, dismissed])

  // 别的地方（聊天里读不到内容时的提示按钮）可以主动把它叫出来
  useEffect(() => {
    const off = onUnlockRequested(() => {
      setDismissed(false)
      setVisible(true)
    })
    return off
  }, [])

  useEffect(() => {
    if (visible) inputRef.current?.focus()
  }, [visible])

  if (!visible || dismissed || !uid || !email) return null
  if (hasLocalRecoveryEph(uid)) return null

  async function handleSubmit(e) {
    e.preventDefault()
    if (busy || !password) return
    setBusy(true)
    setError(null)
    // ── 先向服务器核对这个密码 ──
    // 必须核对：这台设备上还没有钥匙材料，随手指纹都会被"就地新建"一套，
    // 打错一个字就会把账号永久绑到一个错密码上（之后拿真密码反而打不开）。
    // 兼容老账号：库里的认证值可能还是原始密码 → 先试派生值，失败再试原始密码，
    // 原始密码成功说明是老账号 → 静默迁移成派生值（与登录页同一套逻辑）。
    let ok = false
    try {
      const derived = await deriveAuthPassword(password, email)
      let res = await supabase.auth.signInWithPassword({ email, password: derived })
      if (res.error) {
        const legacy = await supabase.auth.signInWithPassword({ email, password })
        if (!legacy.error) {
          ok = true
          supabase.auth.updateUser({ password: derived }).catch(() => {})
        }
      } else {
        ok = true
      }
      if (ok) {
        noteLoginSecrets({ password, credential: derived, email })
        const unlocked = await unlockWithPassword(uid, password, email)
        if (unlocked.ok) {
          await cacheDekOnDevice(uid)   // 写回本机缓存：下次打开就不用再问了
          setPassword('')
          setVisible(false)
        } else {
          setError('这台设备上暂时打不开内容，可以在【我】里请 TA 帮忙')
        }
      } else {
        setError('密码不对，再试一次')
      }
    } catch (err) {
      console.warn('[unlock-prompt] 失败:', err?.message)
      setError('网络不太顺，稍后再试')
    }
    setBusy(false)
  }

  return (
    <div className="unlock-prompt" role="dialog" aria-label="在这台设备上继续">
      <p className="unlock-prompt-title">在这台设备上继续</p>
      <p className="unlock-prompt-text">
        你们的内容只在这两台设备上打得开。请在这台设备上再输入一次密码 —— 只需这一次，以后不会再问。
      </p>
      <form className="unlock-prompt-form" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          type="password"
          placeholder="密码"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" disabled={busy}>{busy ? '稍等…' : '继续'}</button>
      </form>
      {error && <p className="unlock-prompt-error">{error}</p>}
      <button type="button" className="unlock-prompt-later" onClick={() => setDismissed(true)}>
        稍后再说
      </button>
    </div>
  )
}
