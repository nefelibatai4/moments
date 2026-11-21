/**
 * 路由懒加载 / 鉴权等待时的统一占位。
 *
 * 为什么不用"加载中…"这行字：
 * 和 Timeline 的 MomentSkeleton 是同一个原因 —— 一行文字的高度和真实页面差太多，
 * 内容出现时页面会从几十像素跳到整屏，视觉上是一次"顿挫"。
 * 这里用和动态卡片同一套 `.skeleton` 微光与卡片外观提前占位，加载完再换成真实内容。
 *
 * 和 MomentSkeleton 的分工：
 *   * MomentSkeleton 只给时间线列表用（外面是 .timeline，手机/插件下会通栏）；
 *   * 本组件给"还不知道会渲染哪一页"的路由等待用，所以刻意**不挂 .timeline**，
 *     否则手机端 `:has(.timeline)` 会把 main 的左右内边距清零，
 *     等真正页面（如【我】）出来后内边距又回来，反而多一次横向跳动。
 *
 * 无障碍：role="status" + aria-label 让读屏软件知道正在加载；
 * 里面的骨架块都是装饰，不产生可读文本（测试会断言 innerText 为空）。
 */
export default function PageSkeleton({ count = 3, label = '正在加载' }) {
  return (
    <div className="page-skeleton" role="status" aria-label={label}>
      {Array.from({ length: count }).map((_, i) => (
        <article key={i} className="page-skeleton-card" aria-hidden="true">
          <div className="page-skeleton-head">
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
