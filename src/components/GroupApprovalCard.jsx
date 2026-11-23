/**
 * 「需要你确认」卡片 —— **已退役**（2026-11-23）。
 *
 * 使用者原话："取消审批的步骤，谁都可以改任何内容。改之前做快照保存。"
 * 所以桥不再生成新卡片、也不再处理"通过/不通过"；这个组件只负责把**历史卡片**
 * 老实显示出来（不能点，点了也不会有任何事发生），而不是整段消失。
 *
 * 现在要让它动手：任何人直接说「@Ace 执行 …」；动手前桥会给仓库拍快照
 * （见 scripts/ace-snapshot.mjs），出问题可以回退到动手前那一刻。
 */
export default function GroupApprovalCard({ body, nickname = 'Ace' }) {
  const status = body.status ?? 'pending'
  const expired = status === 'pending' && Number.isFinite(Date.parse(body.expiresAt ?? ''))
    && Date.parse(body.expiresAt) < Date.now()
  const task = String(body.task ?? '').trim()

  const statusText = status === 'approved'
    ? '当时点了通过，已经执行过'
    : status === 'rejected'
      ? '当时点了不通过，没有执行'
      : expired || status === 'expired'
        ? '已过期（当时没有处理）'
        : '审批机制已取消：现在直接说「@Ace 执行 …」就行'

  return (
    <div
      className={`group-approval group-approval--${expired ? 'expired' : status}`}
      data-approval-status={expired ? 'expired' : status}
      data-approval-legacy="1"
    >
      <div className="group-approval-head">
        <span className="group-approval-title">需要你确认</span>
        <span className="group-approval-owner">{nickname} 想动手改东西</span>
      </div>
      {task ? <p className="group-approval-task">{task}</p> : null}
      <div className="group-approval-actions">
        <span className="group-approval-status">{statusText}</span>
      </div>
    </div>
  )
}
