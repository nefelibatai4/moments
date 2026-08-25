import { Routes, Route, Link } from 'react-router-dom'
import Timeline from './pages/Timeline'
import Publish from './pages/Publish'
import Login from './pages/Login'
import Register from './pages/Register'
import Profile from './pages/Profile'
import ChatList from './pages/ChatList'
import ChatThread from './pages/ChatThread'
import RequireAuth from './components/RequireAuth'
import { useAuth } from './lib/AuthContext'

export default function App() {
  const session = useAuth()

  return (
    <div className="app-container">
      <header className="app-header">
        <h1><Link to="/">动态</Link></h1>
        {session && (
          <nav>
            <Link to="/publish">发布</Link>
            <Link to="/chat">私聊</Link>
            <Link to="/profile">我</Link>
          </nav>
        )}
      </header>
      <main>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
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
