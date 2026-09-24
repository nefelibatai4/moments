import { Routes, Route, Link } from 'react-router-dom'
import { lazy, Suspense, useEffect } from 'react'
import Timeline from './pages/Timeline'
import RequireAuth from './components/RequireAuth'
import SyncIndicator from './components/SyncIndicator'
import NavIcon from './components/NavIcon'
import { useAccess } from './lib/AuthContext'
import { supabase } from './supabaseClient'
import { subscribeToPush } from './lib/usePushNotification'
import { useUnreadCount } from './lib/useUnreadCount'
import { touchSession } from './lib/userPresence'

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
      // 记一次"上次访问"（IP/国家/设备由服务端从请求头取，客户端伪造不了）
      touchSession()
    }
  }, [session, approved])

  return (
    <div className="app-container">
      {/* ⚠️ 这里刻意**不改 DOM 结构**：同一套 `header > h1 + 指示器 + nav > a`
          由 CSS 按使用场景摆成三种样子（插件顶部横排 / 桌面左侧竖栏 / 手机底部 tab）。
          好处：① 插件形态完全不受影响；② 测试里的 `header nav a`、`.app-header`、
          `.nav-chat-link` 选择器继续有效（e2e 里有一条断言"导航是 3 项"，把
          「动态」留在 h1 里而不是塞进 nav，正是为了不打破它）。
          图标是内联 SVG：不占额外请求，也不给 innerText 添字，文字断言照样过。 */}
      <header className="app-header">
        <h1>
          <Link to="/" className="nav-item">
            <NavIcon name="timeline" />
            <span className="nav-label">动态</span>
          </Link>
        </h1>
        {/* 头部状态指示器（正在上传 NN% / 上次同步 HH:MM）。
            放在【动态】右侧、导航左侧；窄面板下会被 CSS 收紧而不是挤掉导航。 */}
        <SyncIndicator />
        {session && approved && (
          <nav>
            <Link to="/publish" className="nav-item">
              <NavIcon name="publish" />
              <span className="nav-label">发布</span>
            </Link>
            <Link to="/chat" className="nav-item nav-chat-link">
              <NavIcon name="chat" />
              <span className="nav-label">私聊</span>
              {unread > 0 && (
                <span className="nav-unread-badge">{unread > 99 ? '99+' : unread}</span>
              )}
            </Link>
            <Link to="/profile" className="nav-item">
              <NavIcon name="me" />
              <span className="nav-label">我</span>
            </Link>
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
