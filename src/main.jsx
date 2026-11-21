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
import { checkForUpdate } from './lib/updateNotice.js'
import { SHUTDOWN_ENABLED } from './lib/shutdown.js'
import ClosingCountdown from './pages/ClosingCountdown.jsx'
import SplashScreen from './components/SplashScreen.jsx'
import Maintenance from './pages/Maintenance.jsx'
import { MAINTENANCE_ENABLED, probeBackend } from './lib/maintenance.js'
import { installTrafficMeter } from './lib/traffic.js'
import { resetImageAttemptBudget } from './lib/imageCrypto.js'

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

// ── 版本自检（2026-11-16，2026-11-21 改为不打断浏览）──────────────────
// 为什么需要：Pages 的 HTML 有 10 分钟缓存，插件面板常常"打开的还是上一版"——
// 于是同样的 bug 你这边改完了、对方那边看起来没变（我们为此反复解释了好几轮）。
// 这里启动后读一次 dist/version.json（SW 放行、不走缓存）。
// ⚠️ 不要在这里 location.reload()：那会让正在浏览/输入的人经历"二次加载闪烁"。
// 现在只交给 updateNotice 弹一条不阻塞的提示，点了「立即刷新」才换壳；
// 不点也没关系 —— sw.js 的导航请求是网络优先，下次自然打开就是新版本。
checkForUpdate(typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : null)

// 启动时把"未读提示样式"下发一次给扩展（扩展自己也有持久化，这里只是对齐）
import('./lib/unreadStyle.js').then((m) => m.announceUnreadStyle()).catch(() => {})

// 重新联网 / 从后台切回时，给"之前解不开的图"一次新机会（见 resetImageAttemptBudget 的注释）
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => resetImageAttemptBudget())
  let hiddenAt = 0
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return }
    if (hiddenAt && Date.now() - hiddenAt > 30_000) resetImageAttemptBudget()
    hiddenAt = 0
  })
}

const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/'

// 开屏动画是**覆盖层**：底下照常渲染（站点关闭倒计时或正常应用），
// 它淡出后自己消失，不参与路由、不请求数据。`?splash=1` 可以随时预览。
// 开屏动画的**预览**入口（`?splash=1`）：任何人都能看，不消耗时段。
// 真正的启用是"只给指定账号看"，在 App 里按登录账号判断（见 splash.js 的 SPLASH_FOR_IDS）。
function Boot({ children }) {
  const preview = new URLSearchParams(window.location.search).has('splash')
  const [splash, setSplash] = useState(preview)

  // 维护中（2026-10-20）：后台探一次（几百字节），确认不可用就用整页覆盖层盖住。
  // ⚠️ 2026-10-22 使用者反馈"点插件后先看到一个黄色加载页" —— 那是原先在**探活期间**渲染的
  //    维护页底图（米黄渐变）。现在改成：**永远先渲染正常应用**，只在确认不可用时盖上维护页，
  //    所以不会再有任何"黄屏闪过"。
  const [state, setState] = useState(() => (MAINTENANCE_ENABLED ? 'checking' : 'ok'))
  const [status, setStatus] = useState(null)
  useEffect(() => {
    if (!MAINTENANCE_ENABLED) return undefined
    let alive = true
    probeBackend().then((r) => {
      if (!alive) return
      setStatus(r.status)
      // 只有"额度停服（402）"才盖维护页；网络抖动/CORS 失败一律照常渲染应用
      setState(r.ok || !r.restricted ? 'ok' : 'down')
    })
    return () => { alive = false }
  }, [])

  const overlay = preview && splash ? <SplashScreen preview onDone={() => setSplash(false)} /> : null

  return (
    <>
      {children}
      {state === 'down' ? <Maintenance initialStatus={status} onRecovered={() => setState('ok')} /> : null}
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
