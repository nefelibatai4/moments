import { useEffect, useState } from 'react'
import { SHUTDOWN_AT, isShutdownPassed } from '../lib/shutdown'

// 网站关闭倒计时（2026-10-18 使用者要求的临时状态）
//
// 这个页面是**唯一**会渲染的东西：没有导航、没有登录、没有任何数据请求。
// 后端数据一条不动，只是前端不再展示内容。
//
// 时间一律按 +08:00 算（`SHUTDOWN_AT` 里写死时区），不跟随设备本地时区。

function parts(msLeft) {
  const total = Math.max(0, Math.floor(msLeft / 1000))
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  }
}

const pad = (n) => String(n).padStart(2, '0')

export default function ClosingCountdown() {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // 每秒跳一次；后台标签页被降频也无所谓，回来时会立刻对齐（下面用真实时间算，不累加）
    const timer = setInterval(() => setNow(Date.now()), 1000)
    const onVisible = () => { if (!document.hidden) setNow(Date.now()) }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const done = isShutdownPassed(now)
  const left = SHUTDOWN_AT.getTime() - now
  const { days, hours, minutes, seconds } = parts(left)

  return (
    <div className="closing-screen" data-closing-screen data-closing-done={done ? '1' : '0'}>
      <div className="closing-inner">
        <h1 className="closing-title">
          {done ? '网站已关闭' : '网站关闭倒计时'}
        </h1>

        {done ? (
          <p className="closing-sub">感谢你来过。</p>
        ) : (
          <>
            <div className="closing-clock" role="timer" aria-live="off" data-closing-clock>
              {days > 0 && (
                <span className="closing-unit">
                  <span className="closing-num">{days}</span>
                  <span className="closing-label">天</span>
                </span>
              )}
              <span className="closing-unit">
                <span className="closing-num">{pad(hours)}</span>
                <span className="closing-label">时</span>
              </span>
              <span className="closing-unit">
                <span className="closing-num">{pad(minutes)}</span>
                <span className="closing-label">分</span>
              </span>
              <span className="closing-unit">
                <span className="closing-num">{pad(seconds)}</span>
                <span className="closing-label">秒</span>
              </span>
            </div>
            <p className="closing-sub">
              将于 <time dateTime={SHUTDOWN_AT.toISOString()} data-closing-at>
                2026 年 10 月 19 日 24:00
              </time>{' '}
              关闭
            </p>
          </>
        )}
      </div>
    </div>
  )
}
