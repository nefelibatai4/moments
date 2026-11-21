import { Suspense, useEffect, useSyncExternalStore } from 'react'
import { Outlet, useMatch } from 'react-router-dom'
import ChatList from './ChatList'
import NavIcon from '../components/NavIcon'
import { isPanelSurface } from '../lib/surface'

/**
 * 私聊工作区外壳（桌面宽屏三栏）。
 *
 * 第一期只做**骨架**：第一列沿用 App 的左侧竖栏，第二列常驻 ChatList，
 * 第三列放当前会话（或空态）。窄屏仍然只渲染「列表或会话其中一个」——
 * 这一点很关键：手机上如果同时挂一个隐藏的 `.chat-thread`，
 * `html:not([data-surface]):has(.chat-thread) .app-header` 会把底部 tab 栏收掉，
 * /chat 列表页就会变成没有导航的空白页。
 *
 * ⚠️ 阈值 1024 与 index.css 的三栏媒体查询保持一致；插件 surface 在 JS + CSS 双保险。
 * ⚠️ /chat 不自动选中第一条：自动挂载 ChatThread 会在用户没点的情况下写 read_at。
 */
const WIDE_QUERY = '(min-width: 1024px)'

function subscribeWide(callback) {
  const mq = window.matchMedia(WIDE_QUERY)
  mq.addEventListener('change', callback)
  return () => mq.removeEventListener('change', callback)
}

function getWideSnapshot() {
  return window.matchMedia(WIDE_QUERY).matches
}

export default function ChatWorkspace() {
  const wideViewport = useSyncExternalStore(subscribeWide, getWideSnapshot, () => false)
  const wide = wideViewport && !isPanelSurface()
  const privateMatch = useMatch('/chat/:userId')
  const gardenMatch = useMatch('/garden')
  const selectedId = privateMatch?.params?.userId ?? null
  // garden 与私聊都算"有选中项"；/chat 本身不是选中项。
  const selectedKey = gardenMatch ? 'garden' : selectedId

  // 从时间线滚下来再点「私聊」时，窗口可能还停在旧的 scrollY 上。
  // 工作区是 100vh 的固定外壳，先回到顶部，避免第一列/第二列从视口上方被切掉。
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])

  return (
    <div className={`chat-workspace${wide ? ' is-wide' : ''}`} data-chat-wide={wide ? '1' : '0'}>
      {wide ? (
        <>
          <aside className="chat-sidebar" aria-label="会话列表">
            <ChatList
              embedded
              activeId={selectedId}
              activeGroup={Boolean(gardenMatch)}
            />
          </aside>
          <section className="chat-pane" aria-label="对话">
            {selectedKey ? (
              <Suspense fallback={<p className="status-text chat-pane-status">加载中…</p>}>
                <Outlet key={selectedKey} context={{ wide }} />
              </Suspense>
            ) : (
              <div className="chat-empty-pane" data-chat-empty="1">
                <span className="chat-empty-icon" aria-hidden="true"><NavIcon name="chat" /></span>
                <h2>选择一个会话</h2>
                <p>联系人消息会显示在这里。也可以从左侧进入私密圈后花园。</p>
              </div>
            )}
          </section>
        </>
      ) : (
        <Suspense fallback={<p className="status-text">加载中…</p>}>
          <Outlet key={selectedKey ?? 'list'} context={{ wide: false }} />
        </Suspense>
      )}
    </div>
  )
}
