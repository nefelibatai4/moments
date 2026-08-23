import { Routes, Route, Link } from 'react-router-dom'
import Timeline from './pages/Timeline'
import Publish from './pages/Publish'

export default function App() {
  return (
    <div className="app-container">
      <header className="app-header">
        <h1><Link to="/">动态</Link></h1>
        <nav>
          <Link to="/publish">发布</Link>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Timeline />} />
          <Route path="/publish" element={<Publish />} />
        </Routes>
      </main>
    </div>
  )
}
