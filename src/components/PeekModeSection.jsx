import { useState } from 'react'
import { isPeekAllowed, isPeekOn, setPeekOn } from '../lib/peekMode'

// 【我】→「隐身预览」（2026-11-12）
//
// 只有使用者本人（`PEEK_ALLOWED_IDS`）能看到这一块；对方那边**完全不出现**。
// 打开时：进入任何会话都**不写已读**，对方会一直看到"未读"（✓ 而不是 ✓✓）。
export default function PeekModeSection({ session }) {
  const allowed = isPeekAllowed(session?.user)
  const [on, setOn] = useState(() => isPeekOn())

  if (!allowed) return null

  function toggle(next) {
    setOn(next)
    setPeekOn(next)
  }

  return (
    <section className="peek-section" data-peek-section>
      <div className="peek-row">
        <div className="peek-text">
          <span className="peek-title">隐身预览</span>
          <span className="peek-hint">
            {on
              ? '已开启：看会话时对方不会看到"已读"。看完记得关掉 —— 他一直看到未读本身就是一种信号。'
              : '开启后，你看会话时对方不会看到"已读"（✓✓ 不会出现）。只对你显示，对方看不到这个开关。'}
          </span>
        </div>
        <label className="peek-switch">
          <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} />
          <span className="peek-slider" />
        </label>
      </div>
    </section>
  )
}
