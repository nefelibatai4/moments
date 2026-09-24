/**
 * 【正在上传 / 上次同步】指示器的**纯逻辑**（不碰 DOM，方便单独验证）。
 *
 * ⚠️ 现阶段的定位要说清楚：这是**演示用的占位组件**（使用者 2026-09-23 要求
 * "提前加一个按钮组件来看看效果"，为后面的"本地日志文件备份"做准备）。
 * 它**没有真正的上传目标**，进度是按规则造出来的。所以：
 *   · 组件上挂了 title="演示：还没接真正的上传"（鼠标悬停可见），
 *     避免以后有人（包括我们自己）把它当成真的在备份；
 *   · 等真功能做出来时，**把 nextStep/nextCycleDelay 换成真实进度**即可，
 *     其余（显示、上次同步时间的持久化）不用动。
 *
 * 轮换间隔刻意**不定死**：使用者明确要求"五分钟的限制不要定死，需要随机一些"。
 */

export const MIN_CYCLE_MS = 3 * 60 * 1000
export const MAX_CYCLE_MS = 8 * 60 * 1000
/** 真实感的关键：进度不能匀速。偶尔停一下、偶尔快一点，看起来才像真的在传东西。 */
export const STEP_MIN_PERCENT = 1
export const STEP_MAX_PERCENT = 6
export const STEP_MIN_DELAY_MS = 700
export const STEP_MAX_DELAY_MS = 2600
/** 完成之后"上次同步 HH:MM"停留多久再隐去 */
export const DONE_HOLD_MS = 45 * 1000
export const LAST_SYNC_KEY = 'moments_last_sync'

// 随机源可注入（默认 Math.random）：这样测试里可以喂一个确定的序列，
// 把"间隔在 3–8 分钟之间""进度不倒退"这类性质**确定性地**验掉。
const rand = (min, max, r = Math.random) => min + r() * (max - min)

/** 下一次开传的间隔：3–8 分钟之间随机（不是固定 5 分钟） */
export function nextCycleDelay(randFn = Math.random) {
  return Math.round(MIN_CYCLE_MS + randFn() * (MAX_CYCLE_MS - MIN_CYCLE_MS))
}

/** 单次进度增量与间隔，都带随机 */
export function nextStep(randFn = Math.random) {
  return {
    percent: Math.round(rand(STEP_MIN_PERCENT, STEP_MAX_PERCENT, randFn)),
    delay: Math.round(rand(STEP_MIN_DELAY_MS, STEP_MAX_DELAY_MS, randFn)),
  }
}

/**
 * 进度的推进（3–6% 一步，偶尔插一次"卡住"——卡住时百分比不动，像在等网络）。
 * 抽出来是为了能在测试里确定性地验证"不会一步到位、也不会倒退"。
 */
export function advanceProgress(current, randFn = Math.random) {
  const step = nextStep(randFn)
  // 8% 的概率卡一下（delay 拉长、百分比不动），其余照常前进
  if (randFn() < 0.08) return { percent: current, delay: step.delay + 1200 }
  return { percent: Math.min(99, current + step.percent), delay: step.delay }
}

export function formatLastSync(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `上次同步 ${hm}`
}

export function readLastSync() {
  try {
    const raw = localStorage.getItem(LAST_SYNC_KEY)
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export function writeLastSync(ts) {
  try {
    localStorage.setItem(LAST_SYNC_KEY, String(ts))
  } catch {
    /* 存储不可用也不影响这次的显示 */
  }
}
