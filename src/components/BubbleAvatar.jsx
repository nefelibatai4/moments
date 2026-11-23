import SignedImage from './SignedImage'

/**
 * 气泡旁的小圆头像（小红书式：每条消息自己带一个）。
 *
 * 私聊用 `.chat-bubble-avatar`，群聊沿用既有的 `.group-sender-avatar`。
 * 有头像时走 SignedImage 的签名管线，并且是 <button>（点开灯箱）；
 * 没有头像时显示昵称首字母占位，用 <span> —— 没有图可看，不该多一个空按钮/空 Tab 位。
 */
export default function BubbleAvatar({ className, stored, nickname, side, label, onOpen }) {
  const has = !!stored
  if (!has) {
    return (
      <span
        className={className}
        data-bubble-avatar={side}
        data-has-avatar="0"
        aria-label="没有头像"
      >
        {(nickname ?? '?').slice(0, 1)}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={className}
      data-bubble-avatar={side}
      data-has-avatar="1"
      aria-label={`查看${label ?? '头像'}大图`}
      onClick={onOpen}
    >
      <SignedImage bucket="avatars" stored={stored} alt="" />
    </button>
  )
}
