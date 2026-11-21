/**
 * 右栏会话加载骨架。
 *
 * 深链 /chat/:userId 或 /garden 时，第三列要等数据（以及 lazy chunk）。
 * 这里刻意**长得像一条会话**（头 + 消息气泡 + 输入条），高度沿用 .chat-thread
 * 的 flex 链，所以和真正会话同高；不会出现"一行加载中…"然后把整列从几十像素
 * 拉到整屏的顿挫。视觉语言复用页面骨架的 `.skeleton` 微光与设计令牌。
 */
export default function ChatPaneSkeleton({ pane = false, label = '正在加载会话' }) {
  return (
    <div
      className={`chat-thread chat-pane-skeleton${pane ? ' chat-thread--pane' : ''}`}
      role="status"
      aria-label={label}
      data-chat-skeleton="1"
    >
      <div className="chat-thread-header chat-pane-skeleton-header" aria-hidden="true">
        <span className="skeleton chat-skeleton-avatar" />
        <span className="skeleton chat-skeleton-name" />
      </div>
      <div className="chat-messages chat-pane-skeleton-body" aria-hidden="true">
        <span className="skeleton chat-skeleton-bubble theirs" />
        <span className="skeleton chat-skeleton-bubble mine" />
        <span className="skeleton chat-skeleton-bubble theirs short" />
        <span className="skeleton chat-skeleton-bubble mine short" />
      </div>
      <div className="chat-input-row chat-pane-skeleton-input" aria-hidden="true">
        <span className="skeleton chat-skeleton-field" />
        <span className="skeleton chat-skeleton-send" />
      </div>
    </div>
  )
}
