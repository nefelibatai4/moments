import { useEffect, useState } from 'react'
import { SHUTDOWN_AT, TOGETHER_START, daysTogether, isShutdownPassed } from '../lib/shutdown'

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

// 2026.06.27 这种写法比"2026 年 6 月 27 日"更安静，也不占行
function fmtDate(d) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000)   // SHUTDOWN_AT/TOGETHER_START 都是 +08:00
  return `${t.getUTCFullYear()}.${pad(t.getUTCMonth() + 1)}.${pad(t.getUTCDate())}`
}

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
          <>
            {/* 关闭之后只留三行：标题 / 起止日期 / 一共多少天。
                这三行就是"网站运行了多久"，也就是他们在一起的时间 —— 刻意不加别的修饰。 */}
            <p className="closing-range" data-closing-range>
              <time dateTime={TOGETHER_START.toISOString()} data-closing-since>
                {fmtDate(TOGETHER_START)}
              </time>
              <span className="closing-dash" aria-hidden="true">—</span>
              <time dateTime={SHUTDOWN_AT.toISOString()} data-closing-until>
                {fmtDate(SHUTDOWN_AT)}
              </time>
            </p>
            <p className="closing-days" data-closing-days>
              共 {daysTogether()} 天
            </p>
          </>
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
