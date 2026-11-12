import { useState } from 'react'
import { UNREAD_STYLES, getUnreadStyle, setUnreadStyle } from '../lib/unreadStyle'

// 【我】→「未读提示」（2026-11-12）
// 浏览器工具栏图标怎么告诉你"有未读"：数字 / 小红点 / 图标变色。默认数字。
export default function UnreadStyleSection() {
  const [value, setValue] = useState(() => getUnreadStyle())

  function pick(next) {
    setValue(next)
    setUnreadStyle(next)
  }

  return (
    <section className="unread-style-section" data-unread-style>
      <div className="unread-style-head">
        <span className="unread-style-title">未读提示</span>
        <span className="unread-style-hint">{UNREAD_STYLES.find((s) => s.key === value)?.hint}</span>
      </div>
      <div className="unread-style-options" role="radiogroup" aria-label="未读提示样式">
        {UNREAD_STYLES.map((s) => (
          <button
            key={s.key}
            type="button"
            role="radio"
            aria-checked={value === s.key}
            className={`unread-style-option${value === s.key ? ' is-active' : ''}`}
            data-unread-style-option={s.key}
            onClick={() => pick(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </section>
  )
}
