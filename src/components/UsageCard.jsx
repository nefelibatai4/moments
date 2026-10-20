import { useEffect, useMemo, useState } from 'react'
import { cacheStats } from '../lib/mediaCache'
import { humanBytes, fetchServerUsage } from '../lib/usage'
import { onTrafficChange, trafficSummary } from '../lib/traffic'

// 【我】→「流量与存储」
//
// 两栏数字，来源不同、所以分开标：
//   · **本机实测**：应用自己数出来的字节（装在 fetch 上的计量器），≈ 这台设备造成的出站流量
//   · **服务器**：数据库大小 / 媒体占用 / 数据条数（走数据库里的 app_usage()）
//
// 刻意不显示"还剩多少额度"这种会误导的数字：免费额度是组织级的，后台才准。
// 这里给的是"你实际用了多少"，用来判断会不会再超标。

const FREE_EGRESS = 5 * 1024 * 1024 * 1024   // Supabase 免费版每月 5 GB 出站

const fmtDay = (day) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`

export default function UsageCard() {
  const [summary, setSummary] = useState(() => trafficSummary())
  const [cache, setCache] = useState(null)
  const [server, setServer] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const off = onTrafficChange(() => setSummary(trafficSummary()))
    return off
  }, [])

  useEffect(() => {
    let alive = true
    const load = async () => {
      const [c, s] = await Promise.all([
        cacheStats().catch(() => null),
        fetchServerUsage(),
      ])
      if (!alive) return
      setCache(c)
      setServer(s)
      setLoading(false)
    }
    load()
    return () => { alive = false }
  }, [])

  const week = useMemo(() => {
    const map = new Map(summary.days.map((d) => [d.day, d.bytes]))
    const out = []
    for (let i = 6; i >= 0; i -= 1) {
      const ts = Date.now() - i * 86400000
      const key = new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10)
      out.push({ day: key, bytes: map.get(key) ?? 0 })
    }
    return out
  }, [summary])

  const peak = Math.max(1, ...week.map((d) => d.bytes))
  const pct = Math.min(100, (summary.month / FREE_EGRESS) * 100)

  return (
    <section className="usage-card" data-usage-card>
      <div className="usage-head">
        <h3 className="usage-title">流量与存储</h3>
        <span className="usage-hint">本机实测 · 每月额度 5 GB</span>
      </div>

      <div className="usage-bar-row">
        <div className="usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
          <span className="usage-bar-fill" style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%` }} />
        </div>
        <span className="usage-bar-label" data-usage-month>{humanBytes(summary.month)}</span>
      </div>

      <div className="usage-grid">
        <div className="usage-item">
          <span className="usage-k">今天</span>
          <span className="usage-v" data-usage-today>{humanBytes(summary.today)}</span>
        </div>
        <div className="usage-item">
          <span className="usage-k">本月</span>
          <span className="usage-v">{humanBytes(summary.month)}</span>
        </div>
        <div className="usage-item">
          <span className="usage-k">本机图片缓存</span>
          <span className="usage-v" data-usage-cache>
            {cache ? humanBytes(cache.bytes) : '—'}
          </span>
        </div>
        <div className="usage-item">
          <span className="usage-k">服务器·数据库</span>
          <span className="usage-v" data-usage-db>{server?.ok ? humanBytes(server.dbBytes) : '—'}</span>
        </div>
        <div className="usage-item">
          <span className="usage-k">服务器·媒体</span>
          <span className="usage-v" data-usage-media>
            {server?.ok ? `${humanBytes(server.mediaBytes)} / ${server.mediaObjects} 个` : '—'}
          </span>
        </div>
        <div className="usage-item">
          <span className="usage-k">数据条数</span>
          <span className="usage-v">
            {server?.ok ? `${server.moments} 动态 · ${server.messages} 消息` : '—'}
          </span>
        </div>
      </div>

      <div className="usage-week" data-usage-week aria-label="近 7 天流量">
        {week.map((d) => (
          <div className="usage-day" key={d.day} title={`${d.day} · ${humanBytes(d.bytes)}`}>
            <span className="usage-day-bar" style={{ height: `${Math.max(3, (d.bytes / peak) * 100)}%` }} />
            <span className="usage-day-label">{fmtDay(d.day)}</span>
          </div>
        ))}
      </div>

      <p className="usage-note">
        {loading ? '正在读取…' : server?.ok
          ? '数字来自本机计量与数据库统计；服务商后台的月度账单以 Supabase 为准。'
          : '服务器统计暂时读不到（连不上或还没建好统计函数）；本机流量仍在正常记录。'}
      </p>
    </section>
  )
}
