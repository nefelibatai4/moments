import { useEffect } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAccess } from '../lib/AuthContext'
import PageSkeleton from './PageSkeleton'

// 激活状态查询彻底失败时会一直停在加载占位，兜底的重试间隔（见下面的 effect）
const STUCK_RETRY_MS = 5000

/**
 * 路由守卫。
 *
 * requireApproved（默认 true）：要求账号已凭注册口令激活。
 * 未激活的账号可以登录，但读不到任何数据（服务端 RLS 强制），
 * 所以这里直接把它们送到 /activate，避免看到一堆空列表和 RLS 报错。
 * /activate 自己用 requireApproved={false}。
 */
export default function RequireAuth({ children, requireApproved = true }) {
  const { session, approved, refreshApproval } = useAccess()
  const location = useLocation()

  // 激活状态查询重试全失败时 approved 会停在 undefined，界面就一直是加载占位。
  // 这里兜一层：卡住超过几秒就自己再试一次，别让用户只能手动刷新。
  // ⚠️ hooks 必须写在下面的提前 return **之前**，否则路由切换时 hooks 数量会变。
  const stuck = session !== undefined && requireApproved && approved === undefined
  useEffect(() => {
    if (!stuck) return
    const timer = setTimeout(() => { refreshApproval() }, STUCK_RETRY_MS)
    return () => clearTimeout(timer)
  }, [stuck, refreshApproval])

  // 等会话/等激活状态都走同一套骨架占位（与路由懒加载的 Suspense 一致），
  // 不再出现"一行字 → 整页内容"的高度跳变。
  if (session === undefined) return <PageSkeleton label="正在确认登录状态" />

  if (session === null) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (requireApproved) {
    if (approved === undefined) return <PageSkeleton label="正在确认账号权限" />
    if (approved === false) {
      return <Navigate to="/activate" state={{ from: location }} replace />
    }
  }

  return children
}
