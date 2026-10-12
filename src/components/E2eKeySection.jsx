import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import {
  acknowledgeRecoveryCode, ensureIdentity, generateRecoveryCode, hasLocalIdentity,
  identityMatches, localPublicKey, pendingRecoveryCode, restoreIdentityWithCode,
  wrapPrivateWithRecovery,
} from '../lib/e2e'

/**
 * 私聊端到端加密的密钥管理（在【我】里）。
 *
 * 使用者只需要理解两件事：
 *   ① 私聊内容现在是**加密**的：服务器（和我）都看不到正文；
 *   ② 换手机 / 清浏览器数据之前，要把**恢复码**拿出来 —— 没有它，历史消息读不回来。
 *
 * 这个组件负责：首次自动生成密钥、把恢复码给使用者抄、以及在新设备上用恢复码恢复。
 */
export default function E2eKeySection() {
  const session = useAuth()
  const uid = session?.user?.id
  const [status, setStatus] = useState('loading')   // loading | active | needs-restore | unsupported
  const [recoveryCode, setRecoveryCode] = useState(null)
  const [acknowledged, setAcknowledged] = useState(true)
  const [inputCode, setInputCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const refresh = useCallback(async () => {
    if (!uid) return
    if (typeof crypto === 'undefined' || !crypto.subtle) { setStatus('unsupported'); return }
    const pending = pendingRecoveryCode()
    if (pending) { setRecoveryCode(pending); setAcknowledged(false) }

    const local = hasLocalIdentity()
    if (local) {
      // 本机有钥匙：顺手确认服务器上的公钥就是这一把（不一致说明服务器记的是另一把）
      const { data } = await supabase.from('profiles').select('public_key').eq('id', uid).maybeSingle()
      const consistent = identityMatches(data?.public_key)
      setStatus(consistent ? 'active' : 'needs-restore')
      return
    }
    // 本机没钥匙：服务器上有没有公钥？有 → 这是"新设备"，要用恢复码；没有 → 还没开过加密
    const { data } = await supabase.from('profiles').select('public_key').eq('id', uid).maybeSingle()
    setStatus(data?.public_key ? 'needs-restore' : 'new')
  }, [uid])

  // 首次进来：没钥匙就生成（并生成恢复码让使用者抄）
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!uid) return
      if (!hasLocalIdentity()) {
        const { data } = await supabase.from('profiles').select('public_key').eq('id', uid).maybeSingle()
        // 服务器上已经有公钥 = 这是另一台设备 → 不自动生成新钥匙（那会让历史读不回来）
        if (!data?.public_key) {
          const res = await ensureIdentity(uid)
          if (cancelled) return
          if (res.created && res.recoveryCode) { setRecoveryCode(res.recoveryCode); setAcknowledged(false) }
        }
      }
      if (!cancelled) await refresh()
    })()
    return () => { cancelled = true }
  }, [uid, refresh])

  async function handleAcknowledge() {
    acknowledgeRecoveryCode()
    setAcknowledged(true)
    setNotice('好，恢复码不会再自动显示。需要时可以点「重新生成恢复码」。')
  }

  async function handleCopyCode() {
    try {
      await navigator.clipboard.writeText(recoveryCode ?? '')
      setNotice('恢复码已复制 —— 建议存到密码管理器，或抄在纸上')
    } catch {
      setError('复制失败，请手动选中抄下来')
    }
  }

  async function handleRegenerate() {
    setBusy(true); setError(null); setNotice(null)
    try {
      const local = localPublicKey()
      const priv = await importPrivateFromStorage()
      if (!priv) throw new Error('本机没有私钥，无法重新生成恢复码')
      const code = generateRecoveryCode()
      const backup = await wrapPrivateWithRecovery(priv, code)
      const { error: err } = await supabase.from('key_backups')
        .upsert({ user_id: uid, ...backup, updated_at: new Date().toISOString() })
      if (err) throw err
      setRecoveryCode(code)
      setAcknowledged(false)
      localStorage.setItem('moments_e2e_recovery_pending_v1', code)
      setNotice(`已生成新的恢复码（旧恢复码立刻失效）。公钥指纹：${String(local?.x || '').slice(0, 10)}…`)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function handleRestore(e) {
    e.preventDefault()
    setBusy(true); setError(null); setNotice(null)
    try {
      await restoreIdentityWithCode(uid, inputCode)
      setInputCode('')
      setNotice('恢复成功：这台设备现在能读加密消息了')
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (status === 'loading') return null
  if (status === 'unsupported') {
    return (
      <div className="e2e-section">
        <h3>私聊加密</h3>
        <p className="e2e-hint">这个浏览器不支持网页加密（WebCrypto），私聊会保持明文。</p>
      </div>
    )
  }

  return (
    <div className="e2e-section">
      <h3>私聊加密</h3>

      {status === 'active' && (
        <p className="e2e-hint">
          ✅ <strong>已开启</strong>：私聊正文在这台设备上加密后才发出去，服务器只存密文
          （我和云厂商都读不到）。换手机或清浏览器数据前，请先用下面的「恢复码」。
        </p>
      )}

      {status === 'new' && (
        <p className="e2e-hint">
          这台设备还没有加密钥匙。<strong>打开一次这个页面就会自动生成</strong>，
          生成后请把恢复码抄下来。
        </p>
      )}

      {status === 'needs-restore' && (
        <form className="profile-form" onSubmit={handleRestore}>
          <label>这台设备还没有钥匙</label>
          <p className="e2e-hint">
            你之前在别的设备上开过加密。要读那些加密消息，请输入当时的<strong>恢复码</strong>
            （形如 <code>XXXXX-XXXXX-XXXXX-XXXXX</code>）。
          </p>
          <input
            type="text"
            placeholder="恢复码"
            value={inputCode}
            onChange={(e) => setInputCode(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" disabled={busy || !inputCode.trim()}>
            {busy ? '恢复中…' : '用恢复码恢复'}
          </button>
        </form>
      )}

      {recoveryCode && !acknowledged && (
        <div className="e2e-recovery">
          <p className="e2e-hint">
            <strong>请现在把恢复码抄下来</strong>（建议存到密码管理器）。
            换手机、清浏览器数据之后，只有它能找回加密消息；丢了就真的读不回来了。
          </p>
          <p className="e2e-code">{recoveryCode}</p>
          <div className="e2e-code-actions">
            <button type="button" onClick={handleCopyCode}>复制</button>
            <button type="button" onClick={handleAcknowledge}>我已抄下来了</button>
          </div>
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
      {notice && <p className="success-text">{notice}</p>}

      {status === 'active' && (
        <p className="e2e-hint e2e-small">
          公钥指纹：<code>{String(localPublicKey()?.x || '').slice(0, 16)}…</code>
          {' '}
          <button type="button" className="e2e-link" onClick={handleRegenerate} disabled={busy}>
            重新生成恢复码
          </button>
        </p>
      )}
    </div>
  )
}

/** 从 localStorage 里取出本机私钥 JWK（只给"重新生成恢复码"用） */
async function importPrivateFromStorage() {
  try {
    const raw = localStorage.getItem('moments_e2e_identity_v1')
    if (!raw) return null
    return JSON.parse(raw)?.privateKey ?? null
  } catch {
    return null
  }
}
