/**
 * 已读回执图标：10px 圆点 SVG，放在气泡内文字末尾。
 *
 * state:
 *   sent    空心圆 —— 消息已发出（最浅，opacity .3）
 *   read    实心圆 —— 对方已读 / 群里全部已读（opacity .65）
 *   partial 半实心圆（左半实心）—— 群里只读了一部分（opacity .5）
 *
 * 中文只放在 title / aria-label 里：聊天界面（尤其手机）不出现文字，避免挤占气泡。
 */
const DEFAULT_LABEL = {
  sent: '已发送',
  read: '已读',
  partial: '部分已读',
}

export default function ReadMark({ state = 'sent', label, className = '', ...rest }) {
  const text = label || DEFAULT_LABEL[state] || DEFAULT_LABEL.sent
  return (
    <span
      className={`read-mark ${className}`.trim()}
      data-mark-state={state}
      role="img"
      title={text}
      aria-label={text}
      {...rest}
    >
      <svg
        className="read-mark-svg"
        viewBox="0 0 12 12"
        width="10"
        height="10"
        aria-hidden="true"
        focusable="false"
      >
        <circle className="read-mark-ring" cx="6" cy="6" r="4.5" />
        {state === 'read' && (
          <circle className="read-mark-fill" cx="6" cy="6" r="4.5" />
        )}
        {state === 'partial' && (
          <path className="read-mark-fill read-mark-half" d="M6 1.5A4.5 4.5 0 0 0 6 10.5Z" />
        )}
      </svg>
    </span>
  )
}
