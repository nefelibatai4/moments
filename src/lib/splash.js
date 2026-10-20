// 开屏动画（2026-10-18 使用者要求：先做好，等他喊"启用"再打开）
//
// 用法：
//   · 真正启用 → `SPLASH_ENABLED = true`，push 后约 30 秒生效。
//   · 只想看看长什么样（不用改代码）→ 打开 `?splash=1`，线上也能预览。
//   · 每次打开应用只放一次（`sessionStorage` 记住）——刷新不重复，关掉再开才再来一次。
//
// 刻意不做的事：不请求任何数据、不阻塞路由、随时可点掉。它是"门口的一句欢迎"，不是关卡。
export const SPLASH_ENABLED = false

/** 主文案（排版按一行处理；分成两行也能读，见 SplashScreen 里的 SPLASH_SPLIT） */
export const SPLASH_TEXT = '欢迎姜女士回家'

/** 主文案是否拆成两行（"欢迎" / "姜女士回家"）。使用者 2026-10-18 选了**两行** */
export const SPLASH_SPLIT = true

/** 两行时**每行写死**（不能按字数均分：那是"欢迎姜 / 女士回家"，断句就错了） */
export const SPLASH_LINES = ['欢迎', '姜女士回家']

/** 主文案下方的那行小字；留空就不显示 */
export const SPLASH_SUB = ''

/** 整段动画时长（毫秒）；到点就开始淡出，约 0.6 秒后彻底移除 */
export const SPLASH_HOLD_MS = 2400

const SEEN_KEY = 'moments_splash_seen_v1'

/** 这次打开该不该放 */
export function shouldShowSplash() {
  if (typeof window === 'undefined') return false
  const preview = new URLSearchParams(window.location.search).has('splash')
  if (!preview && !SPLASH_ENABLED) return false
  try {
    // 预览时不受"看过"限制，方便反复看效果
    if (!preview && window.sessionStorage.getItem(SEEN_KEY) === '1') return false
  } catch {
    /* 隐私模式没有 sessionStorage，就当没看过 */
  }
  return true
}

/** 放完之后记一笔（同一次打开不再重复） */
export function markSplashSeen() {
  try {
    window.sessionStorage.setItem(SEEN_KEY, '1')
  } catch {
    /* 忽略 */
  }
}
