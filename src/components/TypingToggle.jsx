import { useState } from 'react'
import { isTypingEnabled, setTypingEnabled } from '../lib/typingStatus'

// 【我】→「正在输入提示」（2026-11-16，默认开启）
// 关掉后：你打字对方看不到；对方的你也看不到（本机偏好，不跟账号走）
export default function TypingToggle() {
  const [on, setOn] = useState(() => isTypingEnabled())

  function toggle(next) {
    setOn(next)
    setTypingEnabled(next)
  }

  return (
    <section className="peek-section" data-typing-toggle>
      <div className="peek-row">
        <div className="peek-text">
          <span className="peek-title">正在输入提示</span>
          <span className="peek-hint">
            {on
              ? '你打字时，对方会看到「正在输入…」（只发"在打字"这个信号，不发送任何内容）。'
              : '已关闭：你打字对方看不到；对方打字你也不会看到。'}
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
