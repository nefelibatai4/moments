import { Routes, Route, Link } from 'react-router-dom'
import { lazy, Suspense, useEffect } from 'react'
import Timeline from './pages/Timeline'
import RequireAuth from './components/RequireAuth'
import SyncIndicator from './components/SyncIndicator'
import { useAccess } from './lib/AuthContext'
import { supabase } from './supabaseClient'
import { subscribeToPush } from './lib/usePushNotification'
import { useUnreadCount } from './lib/useUnreadCount'

// 按路由做代码分割：首屏只需要 React + 路由 + Supabase + 时间线，
// 其余页面在真正导航过去时才下载。这样首屏 JS 明显变小。
// Timeline 保持同步引入——它是落地页，做成懒加载会多一次瀑布式请求。
const Publish = lazy(() => import('./pages/Publish'))
const Login = lazy(() => import('./pages/Login'))
const Register = lazy(() => import('./pages/Register'))
const Activate = lazy(() => import('./pages/Activate'))
const Profile = lazy(() => import('./pages/Profile'))
const ChatList = lazy(() => import('./pages/ChatList'))
const ChatThread = lazy(() => import('./pages/ChatThread'))
const UserProfile = lazy(() => import('./pages/UserProfile'))

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
        {/* 头部状态指示器（正在上传 NN% / 上次同步 HH:MM）。
            放在【动态】右侧、导航左侧；窄面板下会被 CSS 收紧而不是挤掉导航。 */}
        <SyncIndicator />
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
        <Suspense fallback={<p className="status-text">加载中…</p>}>
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
            <Route path="/user/:userId" element={<RequireAuth><UserProfile /></RequireAuth>} />
          </Routes>
        </Suspense>
      </main>
    </div>
  )
}
