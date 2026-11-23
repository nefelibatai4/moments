import { useState } from 'react'

/**
 * 「要动手？先点一下」的确认卡片（2026-11-23 使用者要求）。
 *
 * ── 为什么不再靠"说一句执行" ──────────────────────────────────────
 * 原来要 i4 在群里打「@Ace 执行 …」才算授权。使用者原话："感觉特意说一句执行的交互
 * 不是很好"。现在改成：Ace 想动手时，回一句说明 + 一张卡片，卡片上两个按钮
 * 「不通过 / 通过」——点通过就真的开工，点不通过就什么都不做。
 *
 * ── 卡片本身是一条群消息（body.kind === 'approval'）────────────────
 * 为什么不做成浮层：群里三个人看到的是**同一段历史**，卡片留在记录里谁都能回看；
 * 浮层一关就没了，也不进聊天记录（PITFALLS #141 的教训是"权限动作要留痕"）。
 *
 * ── 谁能点 ────────────────────────────────────────────────────
 * 只有建群人（i4）。别人看到的是"等 i4 点一下"。服务端还有一道：桥只认
 * i4 的 sender_id，改了前端也点不动（见 ace-bridge.mjs 的 handleApproval）。
 *
 * ── 状态怎么变 ────────────────────────────────────────────────
 * 点了之后本机先乐观显示"已通过/已不通过"；桥随后会把卡片那条消息**改写**成
 * status: approved/rejected，刷新后仍是一致的。过期（默认 30 分钟）显示"已过期"。
 */
export default function GroupApprovalCard({ body, canDecide, answered, onAnswer, nickname = 'Ace', avatar = null }) {
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState(null)

  const status = answered ?? body.status ?? 'pending'
  const expired = status === 'pending' && Number.isFinite(Date.parse(body.expiresAt ?? ''))
    && Date.parse(body.expiresAt) < Date.now()
  const decided = status !== 'pending'
  const task = String(body.task ?? '').trim()

  const answer = async (approve) => {
    if (busy || decided) return
    setBusy(true)
    setLocalError(null)
    try {
      await onAnswer(approve)
    } catch (err) {
      setLocalError(err?.message ?? '发送失败，再点一次试试')
    } finally {
      setBusy(false)
    }
  }

  const statusText = expired
    ? '已过期（30 分钟内没点，就当我没提）'
    : status === 'approved'
      ? '已通过 —— Ace 正在动手，做完会在群里说'
      : status === 'rejected'
        ? '已不通过 —— Ace 不会动'
        : status === 'expired'
          ? '已过期（30 分钟内没点，就当我没提）'
          : canDecide
            ? '要不要我动手？'
            : '等 i4 点一下'

  return (
    <div className={`group-approval group-approval--${expired ? 'expired' : status}`} data-approval-status={expired ? 'expired' : status}>
      <div className="group-approval-head">
        <span className="group-approval-title">需要你确认</span>
        <span className="group-approval-owner">{nickname} 想动手改东西</span>
      </div>
      {task ? <p className="group-approval-task">{task}</p> : null}
      <div className="group-approval-actions">
        {canDecide && !decided && !expired ? (
          <>
            <button
              type="button"
              className="group-approval-btn group-approval-btn--no"
              onClick={() => answer(false)}
              disabled={busy}
            >
              不通过
            </button>
            <button
              type="button"
              className="group-approval-btn group-approval-btn--yes"
              onClick={() => answer(true)}
              disabled={busy}
            >
              {busy ? '提交中…' : '通过'}
            </button>
          </>
        ) : (
          <span className="group-approval-status">{statusText}</span>
        )}
      </div>
      {localError ? <p className="group-approval-error">{localError}</p> : null}
    </div>
  )
}
