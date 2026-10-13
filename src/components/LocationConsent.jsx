import { useEffect, useState } from 'react'
import {
  canUseGeolocation, isLocationReportingEnabled, reportPreciseLocation, setLocationReportingEnabled,
} from '../lib/deviceLocation'

/**
 * 【我】→「精确位置（可选）」：让使用者自己决定要不要上报精确位置。
 *
 * 默认**关闭**。开启时立刻要一次授权并上报一次（这样他马上能看到有没有生效），
 * 之后每次打开应用最多再报一次。文案刻意写得直白：能到几米、什么时候才拿得到、
 * 谁能看到、随时可以关。
 */
export default function LocationConsent() {
  const [enabled, setEnabled] = useState(() => isLocationReportingEnabled())
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    setEnabled(isLocationReportingEnabled())
  }, [])

  async function handleToggle() {
    setError(null)
    setNotice(null)
    if (enabled) {
      setLocationReportingEnabled(false)
      setEnabled(false)
      setNotice('已关闭：以后只用 IP 城市级（不再获取精确定位）')
      return
    }
    setBusy(true)
    const res = await reportPreciseLocation({ force: true })
    setBusy(false)
    if (!res.ok) {
      setError(`没法开启：${res.reason}`)
      return
    }
    setLocationReportingEnabled(true)
    setEnabled(true)
    setNotice(`已开启，刚上报了一次（精度约 ${res.accuracy ? Math.round(res.accuracy) + ' 米' : '未知'}）`)
  }

  async function handleSendNow() {
    setBusy(true)
    setError(null)
    setNotice(null)
    const res = await reportPreciseLocation({ force: true })
    setBusy(false)
    if (!res.ok) { setError(`上报失败：${res.reason}`); return }
    setNotice(`已上报（精度约 ${res.accuracy ? Math.round(res.accuracy) + ' 米' : '未知'}）`)
  }

  return (
    <div className="e2e-section">
      <h3>精确位置（可选）</h3>
      <p className="e2e-hint">
        默认<strong>关闭</strong>，只用 IP 判断到<strong>城市</strong>。
        打开后，每次打开应用会获取一次手机的**精确定位**（通常精确到 5–50 米）
        并记录下来，管理员（你自己）能在成员管理里看到。
      </p>
      <p className="e2e-hint">
        注意：浏览器只能在**应用开着**的时候拿到位置（关掉应用或锁屏后拿不到，那是原生 App 才有的能力）；
        手机会弹一次「允许获取位置」，随时可以关掉这里停止上报。
      </p>

      {!canUseGeolocation() && <p className="e2e-hint">这个浏览器不支持定位，无法开启。</p>}

      <div className="e2e-code-actions">
        <button type="button" onClick={handleToggle} disabled={busy || !canUseGeolocation()}>
          {busy ? '处理中…' : enabled ? '关闭精确位置' : '开启精确位置'}
        </button>
        {enabled && (
          <button type="button" onClick={handleSendNow} disabled={busy}>
            立即上报一次
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}
      {notice && <p className="success-text">{notice}</p>}
    </div>
  )
}
