import { useEffect } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAccess } from '../lib/AuthContext'

// 激活状态查询彻底失败时会停在"加载中…"，兜底的重试间隔（见下面的 effect）
const STUCK_RETRY_MS = 5000

/**
 * 路由守卫。
 *
 * requireApproved（默认 true）：要求账号已用邀请码激活。
 * 未激活的账号可以登录，但读不到任何数据（服务端 RLS 强制），
 * 所以这里直接把它们送到 /activate，避免看到一堆空列表和 RLS 报错。
 * /activate 自己用 requireApproved={false}。
 */
export default function RequireAuth({ children, requireApproved = true }) {
  const { session, approved, refreshApproval } = useAccess()
  const location = useLocation()

  // 激活状态查询重试全失败时 approved 会停在 undefined，界面就一直是"加载中…"。
  // 这里兜一层：卡住超过几秒就自己再试一次，别让用户只能手动刷新。
  // ⚠️ hooks 必须写在下面的提前 return **之前**，否则路由切换时 hooks 数量会变。
  const stuck = session !== undefined && requireApproved && approved === undefined
  useEffect(() => {
    if (!stuck) return
    const timer = setTimeout(() => { refreshApproval() }, STUCK_RETRY_MS)
    return () => clearTimeout(timer)
  }, [stuck, refreshApproval])

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
