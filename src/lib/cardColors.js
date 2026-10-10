/**
 * 动态卡片颜色的调色板（发布 / 编辑动态时选）。
 *
 * 设计取舍（2026-09-30）：
 *   * **只存 key，不存 hex**：色值由 CSS 按主题给（见 index.css 里的 --moment-tint），
 *     以后微调色板不用改数据，也避免把任意颜色写进库。
 *   * **OKLCH 双主题**：同一个色相/彩度，亮色主题用高 L（浅底）、暗色主题用低 L（深底），
 *     只改亮度就能让两种主题下都既有颜色区分、又不刺眼（对比度也可控）。
 *   * 不引第三方取色器组件：这里只需要"预设色板 + 一个 CSS 变量"，取色器会白涨 bundle。
 *
 * ⚠️ 这份 key 列表必须与数据库约束 `moments_card_color_valid` 保持一致
 *    （见 db-backups/20260930_card_color.sql）。
 */
export const CARD_COLORS = [
  { key: 'default', label: '默认' },
  { key: 'rose', label: '淡粉' },
  { key: 'sky', label: '淡蓝' },
  { key: 'amber', label: '淡黄' },
  { key: 'mint', label: '淡绿' },
  { key: 'violet', label: '淡紫' },
  { key: 'slate', label: '淡灰' },
]

/** 空 / 未知一律当"默认"处理（历史数据 card_color 为 null） */
export function normalizeCardColor(key) {
  return CARD_COLORS.some((c) => c.key === key) ? key : 'default'
}
