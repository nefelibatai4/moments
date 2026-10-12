import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { AuthProvider } from './lib/AuthContext.jsx'
import { initTheme } from './lib/theme.js'
import { initSurface } from './lib/surface.js'
import { initExtensionBridge } from './lib/extensionBridge.js'
import { registerServiceWorker } from './lib/serviceWorker.js'

// 两个都要在首屏渲染前定好，否则会闪一下（主题闪白 / 毛玻璃面板闪出不透明底色）
initTheme()
initSurface()

// 在插件面板里时，由扩展把会话/主题递进来（面板不该依赖那一层 iframe 自己的存储）
initExtensionBridge()

// Service Worker：外壳缓存靠它（推送订阅是登录后再单独走 subscribeToPush）。
// 以前只有"开了推送的人"才注册 SW，所以外壳缓存等于没覆盖到人。
registerServiceWorker()

const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
