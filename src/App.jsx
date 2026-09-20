import { Routes, Route, Link } from 'react-router-dom'
import { useEffect } from 'react'
import Timeline from './pages/Timeline'
import Publish from './pages/Publish'
import Login from './pages/Login'
import Register from './pages/Register'
import Activate from './pages/Activate'
import Profile from './pages/Profile'
import ChatList from './pages/ChatList'
import ChatThread from './pages/ChatThread'
import RequireAuth from './components/RequireAuth'
import { useAccess } from './lib/AuthContext'
import { supabase } from './supabaseClient'
import { subscribeToPush } from './lib/usePushNotification'
import { useUnreadCount } from './lib/useUnreadCount'

export default function App() {
  const { session, approved } = useAccess()
  const unread = useUnreadCount(session && approved ? session.user.id : null)

  // 只有已激活账号才注册 Web Push 订阅
  useEffect(() => {
    if (session && approved) {
      subscribeToPush(supabase, session)
    }
  }, [session, approved])

  return (
    <div className="app-container">
      <header className="app-header">
        <h1><Link to="/">动态</Link></h1>
        {session && approved && (
          <nav>
            <Link to="/publish">发布</Link>
            <Link to="/chat" className="nav-chat-link">
              私聊
              {unread > 0 && (
                <span className="nav-unread-badge">{unread > 99 ? '99+' : unread}</span>
              )}
            </Link>
            <Link to="/profile">我</Link>
          </nav>
        )}
      </header>
      <main>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route
            path="/activate"
            element={<RequireAuth requireApproved={false}><Activate /></RequireAuth>}
          />
          <Route path="/" element={<RequireAuth><Timeline /></RequireAuth>} />
          <Route path="/publish" element={<RequireAuth><Publish /></RequireAuth>} />
          <Route path="/profile" element={<RequireAuth><Profile /></RequireAuth>} />
          <Route path="/chat" element={<RequireAuth><ChatList /></RequireAuth>} />
          <Route path="/chat/:userId" element={<RequireAuth><ChatThread /></RequireAuth>} />
        </Routes>
      </main>
    </div>
  )
}
