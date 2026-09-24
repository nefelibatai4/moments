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
/**
 * 单轮上传的**总耗时**也要随机（使用者 2026-09-23：「上传所需耗时也做个随机」）。
 * 之前只有"每一步随机"，但步数一多就会被大数定律拉平 —— 每轮总是一分钟左右。
 * 现在改成：每轮先摇一个目标时长，进度朝"按目标时长该到哪儿"靠拢（见 nextPercent），
 * 于是总耗时真的会一会儿二十几秒、一会儿三四分钟。
 * 分布刻意偏短：大多数在 25–90 秒，偶尔来一次长的（像真的网络时好时坏）。
 */
export const MIN_DURATION_MS = 20 * 1000
export const MAX_DURATION_MS = 4 * 60 * 1000

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

/** 本轮上传的目标总耗时（随机：70% 短、25% 中、5% 长） */
export function nextCycleDuration(randFn = Math.random) {
  const r = randFn()
  if (r < 0.05) return Math.round(rand(2 * 60 * 1000, MAX_DURATION_MS, randFn))
  if (r < 0.3) return Math.round(rand(90 * 1000, 2 * 60 * 1000, randFn))
  return Math.round(rand(MIN_DURATION_MS, 90 * 1000, randFn))
}

/** 单次进度增量与间隔，都带随机 */
export function nextStep(randFn = Math.random) {
  return {
    percent: Math.round(rand(STEP_MIN_PERCENT, STEP_MAX_PERCENT, randFn)),
    delay: Math.round(rand(STEP_MIN_DELAY_MS, STEP_MAX_DELAY_MS, randFn)),
  }
}

/**
 * 进度的推进：朝"按目标时长此刻该到哪儿"（pace）靠拢，带抖动；
 * 8% 的概率"卡住"一步（百分比不动，像在等网络）。
 *
 * 这样做的原因：光靠"每步随机"会被大数定律拉平（总耗时几乎固定）。
 * 让进度跟着**时间**走，总耗时才会真的等于本轮摇出来的目标时长。
 * 抽成纯函数也便于在测试里确定性地验证"不倒退 / 不一步到位 / 耗时跟得上目标"。
 */
export function nextPercent(current, elapsedMs, targetDurationMs, randFn = Math.random) {
  if (randFn() < 0.08) return current // 卡一下
  const pace = targetDurationMs > 0 ? (elapsedMs / targetDurationMs) * 100 : 100
  const jitter = rand(-6, 6, randFn)
  // ⚠️ 刻意**不加**"每步至少 +1%"的下限：加了之后长耗时就废了 ——
  //    每步至少 1% 会在约 99 个 tick 后到达 99%，把 3 分钟的目标硬压成 ~150 秒，
  //    "耗时随机"就名存实亡（测试里实测到过：目标 180 秒只走了 149 秒）。
  //    现在进度严格跟着时间走：数字可能连着几次不动（正常，像在等网络），
  //    但整轮会落在目标耗时上。
  return Math.round(Math.min(99, Math.max(current, pace + jitter)))
}

/** 推进一次：返回下一个百分比与到下一次的间隔（间隔也带随机） */
export function advanceProgress(current, elapsedMs, targetDurationMs, randFn = Math.random) {
  const { delay } = nextStep(randFn)
  return { percent: nextPercent(current, elapsedMs, targetDurationMs, randFn), delay }
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
