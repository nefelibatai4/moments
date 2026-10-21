import { useEffect, useMemo, useRef, useState } from 'react'
import { MAINTENANCE_UNTIL, PROBE_INTERVAL_MS, probeBackend } from '../lib/maintenance'

// 「维护中」页（2026-10-20）
//
// 只有三块信息：一句"在维护"、一个预计恢复时间、一个倒计时；
// 到了预计时间还没恢复，就把标题换成"正在等待恢复"，继续每 30 秒探一次。
// 探到 200 立刻回调（由 Boot 换成正常应用），不需要重新发布。

const pad = (n) => String(n).padStart(2, '0')

function parts(msLeft) {
  const total = Math.max(0, Math.floor(msLeft / 1000))
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  }
}

export default function Maintenance({ onRecovered, initialStatus = null }) {
  const [now, setNow] = useState(() => Date.now())
  const [status, setStatus] = useState(initialStatus)
  const [checking, setChecking] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // 倒计时：用真实时间算（累加会在后台标签页被降频后失真）
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // 后台探活：恢复就自动进入
  useEffect(() => {
    const tick = async () => {
      const r = await probeBackend()
      if (!alive.current) return
      setStatus(r.status)
      if (r.ok) onRecovered?.()
    }
    const t = setInterval(tick, PROBE_INTERVAL_MS)
    return () => clearInterval(t)
  }, [onRecovered])

  // 文案里的时间从常量算（别写死，改时间就只改一处）
  const untilLabel = useMemo(() => {
    const d = new Date(MAINTENANCE_UNTIL + 8 * 3600 * 1000)
    return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  }, [])

  const left = MAINTENANCE_UNTIL - now
  const overshoot = left <= 0
  const { days, hours, minutes, seconds } = parts(left)

  const reason = useMemo(() => {
    if (status === 402) return '服务器本月流量额度已用完，正在处理中。'
    if (status === null) return '暂时连不上服务器，正在重试。'
    return '服务暂时不可用，正在处理中。'
  }, [status])

  const retry = async () => {
    setChecking(true)
    const r = await probeBackend()
    setStatus(r.status)
    setChecking(false)
    if (r.ok) onRecovered?.()
  }

  return (
    <div className="maint-screen" data-maintenance data-maintenance-status={status ?? 'none'}>
      <div className="maint-inner">
        <p className="maint-badge">维护中</p>

        <h1 className="maint-title">{overshoot ? '正在等待恢复' : '站点维护中'}</h1>
        <p className="maint-reason">{reason}</p>

        {overshoot ? (
          <p className="maint-note" data-maint-waiting>
            预计时间已到，服务商侧还没解除限制。这个页面每 30 秒自动重试，恢复后会自动进入。
          </p>
        ) : (
          <>
            <div className="maint-clock" data-maint-clock>
              {days > 0 && (
                <span className="maint-unit">
                  <span className="maint-num">{days}</span>
                  <span className="maint-label">天</span>
                </span>
              )}
              <span className="maint-unit">
                <span className="maint-num">{pad(hours)}</span>
                <span className="maint-label">时</span>
              </span>
              <span className="maint-unit">
                <span className="maint-num">{pad(minutes)}</span>
                <span className="maint-label">分</span>
              </span>
              <span className="maint-unit">
                <span className="maint-num">{pad(seconds)}</span>
                <span className="maint-label">秒</span>
              </span>
            </div>
            <p className="maint-note">
              预计 <time dateTime={new Date(MAINTENANCE_UNTIL).toISOString()} data-maint-until>
                {untilLabel}
              </time>{' '}
              恢复，恢复后自动进入，无需刷新
            </p>
          </>
        )}

        <p className="maint-fine">数据完好，没有丢失，只是暂时进不来。</p>

        <button className="maint-retry" type="button" onClick={retry} disabled={checking}>
          {checking ? '正在检查…' : '立即重试'}
        </button>
      </div>
    </div>
  )
}
