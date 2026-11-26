/**
 * 已读回执：7px 心形，绝对定位在气泡右下角内部，不占文字布局。
 *
 * state:
 *   sent    1 颗空心心形 —— 消息已发出（最浅，opacity .3）
 *   read    2 颗实心心形 —— 对方已读 / 群里全部已读（opacity .65）
 *   partial 1 实 1 空 —— 群里只读了一部分（opacity .5）
 *
 * 中文只放在 title / aria-label 里：聊天界面（尤其手机）不出现文字，避免挤占气泡。
 */
const DEFAULT_LABEL = {
  sent: '已发送',
  read: '已读',
  partial: '部分已读',
}

// 12×12 视框里的一颗心；空心态只描边，实心态填满。
const HEART_PATH = 'M6 10.5 2.03 6.53A2.9 2.9 0 0 1 6 2a2.9 2.9 0 0 1 3.97 4.53Z'

function Heart({ solid }) {
  return (
    <svg
      className={`read-mark-heart${solid ? ' is-solid' : ''}`}
      viewBox="0 0 12 12"
      width="7"
      height="7"
      aria-hidden="true"
      focusable="false"
    >
      <path d={HEART_PATH} />
    </svg>
  )
}

export default function ReadMark({ state = 'sent', label, className = '', ...rest }) {
  const text = label || DEFAULT_LABEL[state] || DEFAULT_LABEL.sent
  // sent 一颗空心；partial 一实一空；read 两颗实心。
  const total = state === 'sent' ? 1 : 2
  const solid = state === 'read' ? 2 : state === 'partial' ? 1 : 0
  return (
    <span
      className={`read-mark ${className}`.trim()}
      data-mark-state={state}
      role="img"
      title={text}
      aria-label={text}
      {...rest}
    >
      {Array.from({ length: total }, (_, i) => (
        <Heart key={i} solid={i < solid} />
      ))}
    </span>
  )
}
