// 开屏动画「欢迎姜女士回家」（2026-10-18 使用者要求：做好，等他喊"启用"再打开）
//
// 出现规则（使用者 2026-10-18）：
//   **从 0 点开始，每 6 小时算一个时段**（00–06 / 06–12 / 12–18 / 18–24），
//   **每个时段只在他登录后的第一次出现**，同一时段里再刷、再点都不重复。
//   —— 也就是"上午见到一次、下午见到一次"这个手感。
//
// 为什么记在 `localStorage` 而不是 `sessionStorage`：关掉浏览器再来应算"同一次"，
// 只有跨过时段边界才该再放一次。
//
// 用法：
//   · 真正启用 → `SPLASH_ENABLED = true`，push 后约 30 秒生效。
//   · 只想看看长什么样（不用改代码、也不消耗时段）→ `?splash=1`。
//
// 刻意不做的事：不请求任何数据、不阻塞路由、随时可点掉。它是"门口的一句欢迎"，不是关卡。
export const SPLASH_ENABLED = true

// 只给**指定账号**看（使用者 2026-10-18：只有对方那个账户登录时才有这个欢迎界面）。
// 用 uid 判断（稳），邮箱只是备注 + 兜底。
export const SPLASH_FOR_IDS = ['5fc36914-dcbe-4f89-8fb0-147472b84d49']   // 2455336053@qq.com
export const SPLASH_FOR_EMAILS = ['2455336053@qq.com']

/** 主文案（一行版） */
export const SPLASH_TEXT = '欢迎姜女士回家'

/** 是否拆成两行。使用者 2026-10-18 选了**两行** */
export const SPLASH_SPLIT = true

/** 两行时**每行写死**（不能按字数均分：那是"欢迎姜 / 女士回家"，断句就错了） */
export const SPLASH_LINES = ['欢迎', '姜女士回家']

/** 主文案下方的那行小字；留空就不显示 */
export const SPLASH_SUB = ''

/** 整段动画时长（毫秒）；到点就开始淡出，约 0.6 秒后彻底移除 */
export const SPLASH_HOLD_MS = 2400

/** 时段长度（小时）。改 12 = 上午/下午各一次；改 24 = 每天一次 */
export const SPLASH_BUCKET_HOURS = 6

const BUCKET_KEY = 'moments_splash_bucket_v1'

/** 这个账号是不是"该看到欢迎页"的那个人 */
export function isSplashTarget(user) {
  if (!user) return false
  if (SPLASH_FOR_IDS.includes(user.id)) return true
  const email = String(user.email ?? '').toLowerCase()
  return Boolean(email) && SPLASH_FOR_EMAILS.some((e) => e.toLowerCase() === email)
}

const pad = (n) => String(n).padStart(2, '0')

/**
 * 当前时段标识，例如 `20261018-2`（= 2026-10-18 的 12:00–18:00 那一段）。
 * 一律按 +08:00 算，不跟随设备时区 —— 换设备、换时区看到的是同一个时段。
 */
export function currentBucketId(now = Date.now()) {
  const t = new Date(now + 8 * 3600 * 1000)
  const day = `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}`
  const hour = t.getUTCHours()
  return `${day}-${Math.floor(hour / SPLASH_BUCKET_HOURS)}`
}

/**
 * 这次打开该不该放。
 * @param {{ enabled?: boolean, preview?: boolean, now?: number }} [opts]
 *   `enabled` 默认取开关常量；测试可显式传 true 验证时段逻辑（不动线上开关）。
 */
export function shouldShowSplash({ enabled = SPLASH_ENABLED, preview, now = Date.now(), user } = {}) {
  if (typeof window === 'undefined') return false
  const isPreview = preview ?? new URLSearchParams(window.location.search).has('splash')
  if (isPreview) return true        // 预览不受开关/账号/时段限制，也不消耗时段
  if (!enabled) return false
  if (user !== undefined && !isSplashTarget(user)) return false   // 传了账号就必须是他
  try {
    return window.localStorage.getItem(BUCKET_KEY) !== currentBucketId(now)
  } catch {
    return true                     // 隐私模式没有 localStorage：宁可多放一次
  }
}

/** 放完之后记一笔"这个时段已经放过了"（预览不记账） */
export function markSplashSeen({ now = Date.now() } = {}) {
  try {
    window.localStorage.setItem(BUCKET_KEY, currentBucketId(now))
  } catch {
    /* 忽略 */
  }
}
