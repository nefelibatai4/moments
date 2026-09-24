import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'

/**
 * 成员管理（只有管理员看得到）。
 *
 * ⚠️ 真正的权限在服务端：`admin_list_users()` / `admin_delete_user()` 都是
 *    SECURITY DEFINER 函数，函数里第一件事就是 `if not is_admin() then raise`。
 *    这里"只对管理员渲染"纯粹是界面礼貌 —— 就算有人手工调用，服务端也会拒。
 *
 * ⚠️ IP / 国家 / 设备是**从 2026-09-24 才开始记录**的（以前没存过），
 *    所以老记录这几列是空的，界面显示"—"，并在底部写明这一点。
 */

function relTime(ts) {
  if (!ts) return '—'
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

function absTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 设备串太长，截成"Chrome 153 · macOS"这种能看的 */
function shortDevice(ua) {
  if (!ua) return '—'
  const browser = ua.match(/(Edg|Chrome|Firefox|Safari|CriOS|FxiOS)\/[\d.]+/)?.[0] || '未知浏览器'
  const os = /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /iPhone|iPad/.test(ua) ? 'iOS'
      : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows'
          : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${browser} · ${os}` : browser
}

export default function AdminPanel() {
  const session = useAuth()
  const me = session?.user?.id
  const [isAdmin, setIsAdmin] = useState(null)
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  // 删除的两步确认：记下"哪一行正在等确认"
  const [confirming, setConfirming] = useState(null)
  const [deleting, setDeleting] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function check() {
      const { data, error: err } = await supabase
        .from('profiles')
        .select('is_admin')
        .eq('id', me)
        .maybeSingle()
      if (cancelled) return
      if (err) { setIsAdmin(false); return }
      setIsAdmin(!!data?.is_admin)
    }
    if (me) check()
    return () => { cancelled = true }
  }, [me])

  // ⚠️ 分成两个入口：effect 里那次**不能同步 setState**（React 会在 lint 里报
  //    "Avoid calling setState() directly within an effect"，项目里已有同类告警）。
  const fetchUsers = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('admin_list_users')
    if (err) { setError(err.message); return }
    setUsers(data || [])
  }, [])

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    ;(async () => {
      const { data, error: err } = await supabase.rpc('admin_list_users')
      if (cancelled) return
      if (err) setError(err.message)
      else setUsers(data || [])
    })()
    return () => { cancelled = true }
  }, [isAdmin])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    await fetchUsers()
    setLoading(false)
  }, [fetchUsers])

  // 等确认的那一步 5 秒后自动收回，避免误触后一直悬着
  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(null), 5000)
    return () => clearTimeout(t)
  }, [confirming])

  async function handleDelete(user) {
    if (confirming !== user.id) { setConfirming(user.id); return }
    setDeleting(user.id)
    setError(null)
    const { error: err } = await supabase.rpc('admin_delete_user', { p_target: user.id })
    setDeleting(null)
    setConfirming(null)
    if (err) { setError(err.message); return }
    setNotice(`已删除 ${user.nickname}`)
    load()
  }

  if (!isAdmin) return null

  return (
    <div className="admin-panel">
      <div className="admin-head">
        <h3>成员管理</h3>
        <button type="button" className="admin-refresh" onClick={load} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {notice && <p className="success-text">{notice}</p>}

      {users.map((u) => {
        const isMe = u.id === me
        return (
          <div className="admin-user" key={u.id}>
            <div className="admin-user-top">
              <span className="admin-user-name">{u.nickname}</span>
              {u.is_admin && <span className="admin-tag admin">管理员</span>}
              <span className={`admin-tag ${u.approved ? 'ok' : 'wait'}`}>
                {u.approved ? '已激活' : '未激活'}
              </span>
              {isMe && <span className="admin-tag">这是你</span>}
              <button
                type="button"
                className={`admin-delete ${confirming === u.id ? 'confirming' : ''}`}
                onClick={() => handleDelete(u)}
                disabled={isMe || deleting === u.id}
                title={isMe ? '不能删除自己' : '删除这个用户（会清掉其动态/评论/私聊/订阅）'}
              >
                {deleting === u.id ? '删除中…' : confirming === u.id ? '再点一次确认删除' : '删除'}
              </button>
            </div>

            <p className="admin-user-line">{u.email || '（没有邮箱）'}</p>
            {/* ⚠️ 「重新登录」与「最近活跃」必须分开显示：
                last_sign_in_at 只在**输密码/验证**那一刻更新；一直保持登录的人
                可以天天在用、这个时间却停在几天前（使用者 2026-09-24 就被这个误导过）。
                last_active_at 取 打开应用 / 发消息 / 发动态 / 评论 / 会话刷新 里最新的一个。 */}
            <p className="admin-user-line">
              最近活跃 <strong>{relTime(u.last_active_at)}</strong>
              {u.last_active_at ? `（${absTime(u.last_active_at)}）` : ''}
              · 重新登录 {absTime(u.last_sign_in_at)}
            </p>
            <p className="admin-user-line">
              上次打开应用 {u.last_seen_at ? `${relTime(u.last_seen_at)}（${absTime(u.last_seen_at)}）` : '—'}
              {u.session_refreshed_at ? ` · 会话最后续期 ${absTime(u.session_refreshed_at)}` : ''}
            </p>
            <p className="admin-user-line">
              IP {u.last_ip || '—'}{u.last_country ? `（${u.last_country}）` : ''} · 设备 {shortDevice(u.last_device)}
            </p>
            <p className="admin-user-line muted">
              动态 {u.moments_count} · 私聊 {u.messages_count} · 推送订阅 {u.push_count} · 邀请码 {u.invite_code || '—'}
              {u.invite_used_at ? `（${absTime(u.invite_used_at)} 使用）` : ''}
            </p>
            <p className="admin-user-line muted">注册于 {absTime(u.created_at)}</p>
          </div>
        )
      })}

      <p className="admin-hint">
        IP / 国家 / 设备是从 2026-09-24 才开始记录的，之前的记录没有这些数据（显示"—"）。
        删除会连带清掉该用户的动态、评论、私聊与推送订阅，**不可撤销**；存储里的历史图片不会被删除。
        该用户用掉的邀请码会**复位成未使用**，他创建的邀请码会**改归你名下**（不会丢）。
      </p>
    </div>
  )
}
