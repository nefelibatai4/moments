import { supabase } from '../supabaseClient'
import { applyTheme } from './theme'

/**
 * 扩展 → 网页的「全局状态」通道（只在插件的面板里起作用）。
 *
 * ── 为什么需要它（2026-09-23，使用者报「在不同主页点开插件，样子和登录状态都不一样」）
 * 面板是把本站嵌在**别人网页**里的 iframe。那个 iframe 里的 localStorage 属于
 * 第三方上下文，能不能读到、读到的是不是同一份，取决于浏览器的隐私设置与存储策略：
 *   · 读不到 / 被隔离 → 面板里「没登录」，还会用上默认主题（于是"每次都长得不一样"）；
 *   · 极端情况一访问就抛异常 → 应用整个挂不上去，面板一片空白。
 * 而扩展手里**本来就有一份**会话与设置（网页自己同步过去的，见 extension/content.js）。
 * 既然这样，面板就不该再依赖"那一层 iframe 自己的存储"——由扩展直接递进来。
 *
 * ── 安全边界（重要）
 * 消息必须满足 `event.source === window`：只有**本文档自己**发的才算。
 * 宿主网页可以 `iframe.contentWindow.postMessage(...)` 往面板里灌伪造消息，
 * 那种情况下 `event.source` 是父窗口而不是本文档，会被这一条挡掉。
 * 没有这道校验，任何网站都能往面板里塞一个假会话 —— 那就成了钓鱼入口。
 */
const SOURCE = 'moments-ext'

let adopting = false

async function adoptSession(session) {
  if (!session || !session.access_token || !session.refresh_token) return
  if (adopting) return
  adopting = true
  try {
    // 本地已经有会话就不动它：本地那份可能是更新的（例如刚在里面登录过）
    const { data } = await supabase.auth.getSession()
    if (data?.session) return
    await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    })
  } catch {
    // 存储不可用等情况下尽力而为：失败就维持"未登录"，不影响其它功能
  } finally {
    adopting = false
  }
}

function handle(message) {
  if (!message || message.source !== SOURCE || message.type !== 'state') return

  // 主题：以扩展手里的为准（那是"使用者在【我】里选的那个"）
  if (message.theme) {
    applyTheme(message.theme)
    // ⚠️ 同时写进本地存储。只改 DOM 属性的话会出现"页面是浅色、但【我】里的
    //   开关显示深色"这种自相矛盾的状态 —— 因为那个开关读的是 localStorage。
    // 写回去也不会打架：content.js 只在"有显式值"时才上报，值又和扩展一致，循环即止。
    try {
      localStorage.setItem('moments_theme', message.theme)
    } catch {
      /* 存储不可用也不影响这次的显示 */
    }
  }

  // 面板背景：写进本地，让【我】里的设置界面显示正确。
  // ⚠️ 只有"本地那份确实不一样"时才写 + 广播：
  //    广播会触发 content.js 把本地值**上报**给扩展；如果每次都广播，
  //    扩展刚下发的值又会被原样上报回去，和"使用者在别处改的值"抢，
  //    表现为设置偶尔被旧值覆盖（测试里真的抓到过：改成 24px 又被拉回 12px）。
  if (message.panelBg) {
    try {
      localStorage.setItem('moments_panel_bg', JSON.stringify(message.panelBg))
    } catch {
      /* 存储不可用也不影响浮层本身（它取的是扩展里那份） */
    }
    // ⚠️ 这里**刻意不广播**。广播会被 content.js 当成"使用者改了设置"上报给扩展，
    //    而下发本身就是从扩展来的 —— 那会形成"下发→上报→下发"的回环，
    //    把这个值又原样顶回去（测试里实测到：改成 24px 后立刻被拉回 12px）。
    //    真正由使用者触发的修改走 setPanelBg()，那里会广播。
  }

  if (message.session) adoptSession(message.session)
}

export function initExtensionBridge() {
  window.addEventListener('message', (e) => {
    // ⚠️ 只认"本文档自己发的"：宿主网页往 iframe 里灌的消息 event.source 是父窗口
    if (e.source !== window) return
    handle(e.data)
  })

  // 再主动问一次：content.js 在 document_start 就发了，但极端情况下可能早于本脚本注册监听
  try {
    window.postMessage({ source: 'moments-app', type: 'state-request' }, '*')
  } catch {
    /* 忽略 */
  }
}
