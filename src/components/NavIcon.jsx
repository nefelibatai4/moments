/**
 * 导航图标（内联 SVG，不引任何依赖）。
 *
 * 为什么自己画：手机底部 tab 栏需要图标（使用者 2026-09-24 选定"加图标 + 文字"），
 * 但项目里没有现成的图标资源（`public/icons.svg` 里只有一个没用到的模板图标）。
 * 内联 SVG 的好处是**不增加请求、不引包、颜色跟随 currentColor**，
 * 而且 `innerText` 里不会多出文本 —— 测试里 `header nav a` 的文字断言不受影响。
 *
 * 视觉：线性图标，1.6 描边，20×20，与界面里其它图标（如 ×）一致。
 */
const base = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
  focusable: 'false',
}

export default function NavIcon({ name }) {
  if (name === 'timeline') {
    // 动态：一条时间线 + 两张卡片
    return (
      <svg {...base}>
        <path d="M4 5.5h16" />
        <rect x="4" y="9" width="16" height="4.5" rx="1.5" />
        <rect x="4" y="16" width="10" height="4" rx="1.5" />
      </svg>
    )
  }
  if (name === 'publish') {
    // 发布：加号方框
    return (
      <svg {...base}>
        <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
        <path d="M12 8.5v7M8.5 12h7" />
      </svg>
    )
  }
  if (name === 'chat') {
    // 私聊：对话气泡
    return (
      <svg {...base}>
        <path d="M20.5 12.2c0 3.9-3.8 7-8.5 7-1 0-2-.15-2.9-.42L4.5 20.5l1.1-3.3A6.7 6.7 0 0 1 3.5 12.2c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7Z" />
      </svg>
    )
  }
  // me：人像
  return (
    <svg {...base}>
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M4.8 20c.7-3.6 3.7-5.6 7.2-5.6s6.5 2 7.2 5.6" />
    </svg>
  )
}
