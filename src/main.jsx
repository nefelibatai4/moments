import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { AuthProvider } from './lib/AuthContext.jsx'
import { initTheme } from './lib/theme.js'
import { initSurface } from './lib/surface.js'
import { initExtensionBridge } from './lib/extensionBridge.js'
import { registerServiceWorker } from './lib/serviceWorker.js'
import { SHUTDOWN_ENABLED } from './lib/shutdown.js'
import ClosingCountdown from './pages/ClosingCountdown.jsx'
import SplashScreen from './components/SplashScreen.jsx'

// 两个都要在首屏渲染前定好，否则会闪一下（主题闪白 / 毛玻璃面板闪出不透明底色）
initTheme()
initSurface()

// 在插件面板里时，由扩展把会话/主题递进来（面板不该依赖那一层 iframe 自己的存储）
initExtensionBridge()

// Service Worker：外壳缓存靠它（推送订阅是登录后再单独走 subscribeToPush）。
// 以前只有"开了推送的人"才注册 SW，所以外壳缓存等于没覆盖到人。
registerServiceWorker()

const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/'

// 开屏动画是**覆盖层**：底下照常渲染（站点关闭倒计时或正常应用），
// 它淡出后自己消失，不参与路由、不请求数据。`?splash=1` 可以随时预览。
// 开屏动画的**预览**入口（`?splash=1`）：任何人都能看，不消耗时段。
// 真正的启用是"只给指定账号看"，在 App 里按登录账号判断（见 splash.js 的 SPLASH_FOR_IDS）。
function Boot({ children }) {
  const preview = new URLSearchParams(window.location.search).has('splash')
  const [splash, setSplash] = useState(preview)
  return (
    <>
      {children}
      {preview && splash ? <SplashScreen preview onDone={() => setSplash(false)} /> : null}
    </>
  )
}

// 网站关闭倒计时（临时状态）：只渲染这一个页面 ——
// 不挂路由、不挂 AuthProvider，因此**不会**发起任何鉴权/数据请求，后端数据一条不动。
if (SHUTDOWN_ENABLED) {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <Boot>
        <ClosingCountdown />
      </Boot>
    </StrictMode>,
  )
} else {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <Boot>
        <BrowserRouter basename={basename}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </Boot>
    </StrictMode>,
  )
}
