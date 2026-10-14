/**
 * 动态的"心情/状态"。
 *
 * ⚠️ 这张表与服务器端的白名单约束**必须一起改**：
 *    `db-backups/20261014_moment_mood.sql` 里的 `moments_mood_valid`（现在只允许 'rain'）。
 *    加新心情 = 一条小迁移扩白名单 + 这里加一行；两边都改了，客户端与服务器才只有一个"合法心情"来源。
 *
 * 心情是**明文元数据**（和 card_color 一样，不参与端到端加密）——取舍见 SECURITY.md。
 */
export const MOODS = [
  { key: 'rain', label: '下雨', emoji: '🌧' },
]

export function moodByKey(key) {
  if (!key) return null
  return MOODS.find((m) => m.key === key) ?? null
}
