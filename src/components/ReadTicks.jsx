/**
 * 已读回执图标：12px 双勾 SVG。
 *
 * state:
 *   sent    单勾 —— 消息已发出
 *   read    双勾 —— 对方已读 / 群里全部已读
 *   partial 双勾、第二勾变淡 —— 群里只读了一部分
 *
 * 中文只放在 title / aria-label 里：聊天界面（尤其手机）不出现文字，避免挤占气泡。
 */
const DEFAULT_LABEL = {
  sent: '已发送',
  read: '已读',
  partial: '部分已读',
}

export default function ReadTicks({ state = 'sent', label, className = '', ...rest }) {
  const showSecond = state === 'read' || state === 'partial'
  const text = label || DEFAULT_LABEL[state] || DEFAULT_LABEL.sent
  return (
    <span
      className={`read-ticks ${className}`.trim()}
      data-tick-state={state}
      role="img"
      title={text}
      aria-label={text}
      {...rest}
    >
      <svg
        className={`read-ticks-svg${showSecond ? '' : ' is-single'}`}
        viewBox="0 0 12 12"
        width="12"
        height="12"
        aria-hidden="true"
        focusable="false"
      >
        <path className="read-tick" d="M0.7 6.6 3 8.9 6.5 4.6" />
        {showSecond && (
          <path
            className={`read-tick${state === 'partial' ? ' is-partial' : ''}`}
            d="M5.5 6.6 7.8 8.9 11.3 4.6"
          />
        )}
      </svg>
    </span>
  )
}
