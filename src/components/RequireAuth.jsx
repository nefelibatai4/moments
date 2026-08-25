import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/AuthContext'

export default function RequireAuth({ children }) {
  const session = useAuth()
  const location = useLocation()

  if (session === undefined) return <p className="status-text">加载中…</p>
  if (session === null) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  return children
}
