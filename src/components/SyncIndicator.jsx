import { useEffect, useRef, useState } from 'react'
import {
  advanceProgress,
  nextCycleDelay,
  nextCycleDuration,
  readLastSync,
  writeLastSync,
  formatLastSync,
  DONE_HOLD_MS,
} from '../lib/syncProgress'

/**
 * 头部【动态】右侧的状态指示器：安静时什么都不显示，做事时显示「正在上传 NN%」，
 * 完成后显示「上次同步 HH:MM」。
 *
 * ⚠️ **现在还没有真正的上传目标**（使用者 2026-09-23 要"先加个组件看看效果"，
 * 为后面的本地日志备份做准备）。进度是按规则造出来的：3–6% 一步、偶尔卡一下、
 * 每 **3–8 分钟**一轮（刻意不固定 5 分钟）。
 * ⚠️ 使用者 2026-09-23 要求**去掉界面上的「演示」提示**，所以组件上不再有那段悬停文案；
 * 但下面这段说明保留在代码里，避免以后（包括我们自己）误以为它已经在真的上传。
 * 接真功能时，只要把 `step()` 里那一步换成**真实进度**，其余不用动。
 *
 * ⚠️ 实现上刻意**不在 setState 的更新函数里做副作用**（那是 React 明令禁止的，
 * StrictMode 下会双跑，项目里也踩过同类坑）：进度用 ref 保存，定时器在普通函数里排。
 */
export default function SyncIndicator() {
  const [phase, setPhase] = useState('idle') // idle | uploading | done
  const [percent, setPercent] = useState(0)
  const [lastSync, setLastSync] = useState(() => readLastSync())
  const percentRef = useRef(0)
  // 本轮的目标耗时（开轮时随机摇一个），进度朝它靠拢
  const targetRef = useRef(0)
  const startedAtRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    let timer = null
    const later = (fn, ms) => {
      timer = setTimeout(() => { if (!cancelled) fn() }, ms)
    }

    function startCycle() {
      percentRef.current = 0
      // 每轮先摇一个目标总耗时（20 秒–4 分钟），这一步是"耗时随机"的关键
      targetRef.current = nextCycleDuration()
      startedAtRef.current = Date.now()
      setPercent(0)
      setPhase('uploading')
      later(step, 400)
    }

    function step() {
      const elapsed = Date.now() - startedAtRef.current
      const { percent: next, delay } = advanceProgress(percentRef.current, elapsed, targetRef.current)
      if (next >= 99) {
        // 到站：显示 100%、记下"上次同步时间"，停留一会儿再回到安静状态
        later(() => {
          percentRef.current = 100
          setPercent(100)
          const now = Date.now()
          writeLastSync(now)
          setLastSync(now)
          setPhase('done')
          later(() => {
            setPhase('idle')
            later(startCycle, nextCycleDelay())
          }, DONE_HOLD_MS)
        }, delay)
        return
      }
      percentRef.current = next
      setPercent(next)
      later(step, delay)
    }

    // 开局先随机等一小会儿：免得每次刷新都在同一秒开始（更像真的后台任务）
    later(startCycle, Math.round(1500 + Math.random() * 4000))

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  // 还没同步过也照样渲染（显示"尚未同步"）：否则新装的人打开页面看不到任何东西，
  // 会以为这个功能没生效 —— 使用者加它就是为了先看效果。
  const waiting = phase === 'idle' && !lastSync

  return (
    <span className={`sync-indicator ${waiting ? 'waiting' : phase}`}>
      {waiting ? (
        <span className="sync-indicator-label">尚未同步</span>
      ) : phase === 'uploading' ? (
        <>
          <span className="sync-indicator-label">正在上传</span>
          <span className="sync-indicator-percent">{percent}%</span>
        </>
      ) : (
        <span className="sync-indicator-label">{formatLastSync(lastSync)}</span>
      )}
    </span>
  )
}
