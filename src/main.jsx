import { StrictMode, useEffect, useState } from 'react'
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
import Maintenance from './pages/Maintenance.jsx'
import { MAINTENANCE_ENABLED, probeBackend } from './lib/maintenance.js'
import { installTrafficMeter } from './lib/traffic.js'

// 两个都要在首屏渲染前定好，否则会闪一下（主题闪白 / 毛玻璃面板闪出不透明底色）
initTheme()
initSurface()

// 在插件面板里时，由扩展把会话/主题递进来（面板不该依赖那一层 iframe 自己的存储）
initExtensionBridge()

// Service Worker：外壳缓存靠它（推送订阅是登录后再单独走 subscribeToPush）。
// 以前只有"开了推送的人"才注册 SW，所以外壳缓存等于没覆盖到人。
registerServiceWorker()

// 流量计量（2026-10-20）：包一层 fetch，把响应字节数记在本机（【我】→ 流量与存储）
installTrafficMeter()

const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/'

// 开屏动画是**覆盖层**：底下照常渲染（站点关闭倒计时或正常应用），
// 它淡出后自己消失，不参与路由、不请求数据。`?splash=1` 可以随时预览。
// 开屏动画的**预览**入口（`?splash=1`）：任何人都能看，不消耗时段。
// 真正的启用是"只给指定账号看"，在 App 里按登录账号判断（见 splash.js 的 SPLASH_FOR_IDS）。
function Boot({ children }) {
  const preview = new URLSearchParams(window.location.search).has('splash')
  const [splash, setSplash] = useState(preview)

  // 维护中（2026-10-20）：先探一次后端（几百字节）。
  //   200 → 照常进应用（服务商解封后不需要改代码重发）
  //   402 → 显示维护页，页内每 30 秒再探，恢复后自动进入
  const [state, setState] = useState(() => (MAINTENANCE_ENABLED ? 'checking' : 'ok'))
  const [status, setStatus] = useState(null)
  useEffect(() => {
    if (!MAINTENANCE_ENABLED) return undefined
    let alive = true
    probeBackend().then((r) => {
      if (!alive) return
      setStatus(r.status)
      setState(r.ok ? 'ok' : 'down')
    })
    return () => { alive = false }
  }, [])

  const overlay = preview && splash ? <SplashScreen preview onDone={() => setSplash(false)} /> : null

  if (state === 'checking') {
    return (
      <>
        <div className="maint-screen" data-maintenance data-maintenance-status="checking" />
        {overlay}
      </>
    )
  }
  if (state === 'down') {
    return (
      <>
        <Maintenance initialStatus={status} onRecovered={() => setState('ok')} />
        {overlay}
      </>
    )
  }
  return (
    <>
      {children}
      {overlay}
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
