/**
 * 动态卡片的加载骨架屏。
 *
 * 为什么不用"加载中…"这行字：
 * 文字一闪 → 内容出现，页面高度从几十像素跳到上千像素，视觉上是一次"顿挫"。
 * 骨架屏用接近真实卡片的布局提前占位，高度不会突变，观感顺滑得多。
 *
 * 微光动画走 transform（合成器处理），不走 background-position（每帧重绘），
 * 这样在 120Hz 屏幕上也能跑满帧率。
 */
export default function MomentSkeleton({ count = 3 }) {
  return (
    <div className="timeline" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <article key={i} className="moment-skeleton-card moment-skeleton">
          <div className="moment-header">
            <span className="skeleton skeleton-avatar" />
            <span className="skeleton skeleton-name" />
          </div>
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-line short" />
        </article>
      ))}
    </div>
  )
}
