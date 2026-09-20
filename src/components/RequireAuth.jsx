import { Navigate, useLocation } from 'react-router-dom'
import { useAccess } from '../lib/AuthContext'

/**
 * 路由守卫。
 *
 * requireApproved（默认 true）：要求账号已用邀请码激活。
 * 未激活的账号可以登录，但读不到任何数据（服务端 RLS 强制），
 * 所以这里直接把它们送到 /activate，避免看到一堆空列表和 RLS 报错。
 * /activate 自己用 requireApproved={false}。
 */
export default function RequireAuth({ children, requireApproved = true }) {
  const { session, approved } = useAccess()
  const location = useLocation()

  if (session === undefined) return <p className="status-text">加载中…</p>

  if (session === null) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (requireApproved) {
    if (approved === undefined) return <p className="status-text">加载中…</p>
    if (approved === false) {
      return <Navigate to="/activate" state={{ from: location }} replace />
    }
  }

  return children
}
