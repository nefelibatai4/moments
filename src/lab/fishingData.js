// 「摸鱼」小游戏的数据表：鱼种 / 稀有度 / 六级词库。
//
// 实验室规矩：这里只有静态数据，不读动态、私聊或钥匙，也不写用户数据。
// 玩家的鱼库落在 localStorage（按用户 id 分开），在线渔友通过 Supabase
// Realtime 的 presence 互通——不建表、不写库，关掉页面就下线。

export const RARITY_ORDER = ['common', 'rare', 'precious', 'luxury', 'endangered']

export const RARITIES = {
  common: {
    id: 'common',
    label: '普通',
    color: '#8fd0d8',
    soft: 'rgba(143, 208, 216, 0.16)',
    points: 10,
    weight: 50,
    speed: [26, 42],
    radius: 1.12,
    desc: '海里最常见的邻居，网大一点就能兜住。',
  },
  rare: {
    id: 'rare',
    label: '稀有',
    color: '#55b3ff',
    soft: 'rgba(85, 179, 255, 0.16)',
    points: 25,
    weight: 28,
    speed: [38, 56],
    radius: 0.98,
    desc: '颜色开始不一样了，游得也更快。',
  },
  precious: {
    id: 'precious',
    label: '珍贵',
    color: '#b48cff',
    soft: 'rgba(180, 140, 255, 0.16)',
    points: 60,
    weight: 14,
    speed: [52, 72],
    radius: 0.84,
    desc: '得看准角度、等它经过网口。',
  },
  luxury: {
    id: 'luxury',
    label: '豪华',
    color: '#ffbc33',
    soft: 'rgba(255, 188, 51, 0.16)',
    points: 140,
    weight: 6,
    speed: [64, 86],
    radius: 0.7,
    desc: '一身好颜色，滑得像一道光。',
  },
  endangered: {
    id: 'endangered',
    label: '濒危',
    color: '#ff6363',
    soft: 'rgba(255, 99, 99, 0.16)',
    points: 320,
    weight: 2,
    speed: [78, 104],
    radius: 0.56,
    desc: '深海里最难的影子，遇到就是运气。',
  },
}

// 20 种鱼：每种都有自己的体型、配色、花纹和游速。
export const FISH_SPECIES = [
  // ── 普通 ──────────────────────────────────────────────
  {
    id: 'clown', name: '橙纹小丑鱼', rarity: 'common', shape: 'round', tail: 'fan',
    pattern: 'stripes', body: '#ff9a5a', fin: '#ff6f3c', accent: '#fff1df',
    size: 1.55, speed: 1, glow: false,
    desc: '在海葵边打转的常客，胆子大，网也最好下。',
  },
  {
    id: 'sardine', name: '银线沙丁鱼', rarity: 'common', shape: 'long', tail: 'fork',
    pattern: 'none', body: '#cfe6ee', fin: '#7ea9bb', accent: '#f6ffff',
    size: 1.7, speed: 1.15, glow: false,
    desc: '成群结队地游，银色的侧面会反光。',
  },
  {
    id: 'damsel', name: '黄尾雀鲷', rarity: 'common', shape: 'round', tail: 'fan',
    pattern: 'none', body: '#ffd166', fin: '#4aa3df', accent: '#fff3bf',
    size: 1.45, speed: 1.05, glow: false,
    desc: '尾巴像一小片柠檬，在礁石缝里进进出出。',
  },
  {
    id: 'grouper', name: '青石斑', rarity: 'common', shape: 'round', tail: 'round',
    pattern: 'spots', body: '#5e8c6a', fin: '#3c5f4a', accent: '#c8e6c9',
    size: 1.85, speed: 0.86, glow: false,
    desc: '趴在礁石边，一身墨绿斑点，懒得动。',
  },

  // ── 稀有 ──────────────────────────────────────────────
  {
    id: 'butterfly', name: '紫翼蝴蝶鱼', rarity: 'rare', shape: 'flat', tail: 'fan',
    pattern: 'stripes', body: '#b48cff', fin: '#6d4bb3', accent: '#ffe9a8',
    size: 1.55, speed: 1.05, glow: false,
    desc: '翅膀上有一圈紫边，游起来像翻书。',
  },
  {
    id: 'dragonet', name: '赤焰龙鱼', rarity: 'rare', shape: 'long', tail: 'ribbon',
    pattern: 'glow', body: '#ff6b4a', fin: '#c0392b', accent: '#ffd166',
    size: 1.6, speed: 1.18, glow: true,
    desc: '红得像一小团火，只在深水出现。',
  },
  {
    id: 'ray', name: '月白鳐', rarity: 'rare', shape: 'ray', tail: 'ribbon',
    pattern: 'none', body: '#d9f2ff', fin: '#8fcfe8', accent: '#ffffff',
    size: 1.75, speed: 1, glow: false,
    desc: '贴着沙底滑行，像一片会动的月光。',
  },
  {
    id: 'seahorse', name: '翡翠海马', rarity: 'rare', shape: 'seahorse', tail: 'ribbon',
    pattern: 'spots', body: '#4fd1a5', fin: '#1f8f74', accent: '#c7ffe9',
    size: 1.45, speed: 0.9, glow: false,
    desc: '用尾巴勾住海草，风一大就躲起来。',
  },

  // ── 珍贵 ──────────────────────────────────────────────
  {
    id: 'tang', name: '金环刺尾鱼', rarity: 'precious', shape: 'flat', tail: 'fan',
    pattern: 'none', body: '#ffc857', fin: '#2d6cdf', accent: '#fff1b8',
    size: 1.55, speed: 1.1, glow: false,
    desc: '身上有一圈金线，警觉时颜色会变深。',
  },
  {
    id: 'lantern', name: '深海灯笼鱼', rarity: 'precious', shape: 'round', tail: 'fan',
    pattern: 'glow', body: '#2a5d8f', fin: '#163a5f', accent: '#8ff0ff',
    size: 1.35, speed: 1.08, glow: true,
    desc: '提着一盏小灯，在暗处等猎物靠近。',
  },
  {
    id: 'lionfish', name: '珊瑚狮子鱼', rarity: 'precious', shape: 'fan', tail: 'fan',
    pattern: 'stripes', body: '#ff6f61', fin: '#b33a3a', accent: '#fff0e6',
    size: 1.6, speed: 1.02, glow: false,
    desc: '鳍像展开的扇子，漂亮，但不好惹。',
  },
  {
    id: 'seadragon', name: '琉璃海龙', rarity: 'precious', shape: 'ribbon', tail: 'ribbon',
    pattern: 'none', body: '#6ee7ff', fin: '#1d7f99', accent: '#e0ffff',
    size: 1.75, speed: 0.95, glow: true,
    desc: '半透明的一缕青色，游得慢，藏得深。',
  },

  // ── 豪华 ──────────────────────────────────────────────
  {
    id: 'angelfish', name: '极光神仙鱼', rarity: 'luxury', shape: 'flat', tail: 'fan',
    pattern: 'stripes', body: '#c4a7ff', fin: '#7a5cff', accent: '#ffd6ff',
    size: 1.5, speed: 1.16, glow: true,
    desc: '鳞片会随水光变色，很难锁定。',
  },
  {
    id: 'stonefish', name: '黑曜石鬼鲉', rarity: 'luxury', shape: 'round', tail: 'round',
    pattern: 'spots', body: '#3d3550', fin: '#1f1a2e', accent: '#8f7bb3',
    size: 1.65, speed: 0.92, glow: false,
    desc: '颜色像海底的石头，一动不动。',
  },
  {
    id: 'sunfish', name: '珍珠翻车鱼', rarity: 'luxury', shape: 'sun', tail: 'round',
    pattern: 'none', body: '#d9dee8', fin: '#8c96a8', accent: '#ffffff',
    size: 1.85, speed: 0.85, glow: true,
    desc: '圆得像一枚银币，晒太阳时最容易被看见。',
  },
  {
    id: 'sailfish', name: '烈焰旗鱼', rarity: 'luxury', shape: 'sail', tail: 'fork',
    pattern: 'stripes', body: '#ff5d73', fin: '#2d6cdf', accent: '#ffe1e6',
    size: 1.9, speed: 1.22, glow: false,
    desc: '背鳍像一面红旗，冲刺起来只留一道影子。',
  },

  // ── 濒危 ──────────────────────────────────────────────
  {
    id: 'whaleshark', name: '幽灵鲸鲨', rarity: 'endangered', shape: 'shark', tail: 'fork',
    pattern: 'spots', body: '#345a8a', fin: '#1b3355', accent: '#d9f2ff',
    size: 2.25, speed: 1.02, glow: true,
    desc: '巨大的影子，身上的星点像另一片海。',
  },
  {
    id: 'goldgrouper', name: '黄金龙趸', rarity: 'endangered', shape: 'round', tail: 'round',
    pattern: 'spots', body: '#ffd700', fin: '#b8860b', accent: '#fff4b8',
    size: 2.05, speed: 1.08, glow: true,
    desc: '通体金黄，只在最深的海沟露面。',
  },
  {
    id: 'coelacanth', name: '琉璃腔棘鱼', rarity: 'endangered', shape: 'long', tail: 'round',
    pattern: 'spots', body: '#4a7cff', fin: '#1e3a8a', accent: '#c7d8ff',
    size: 1.95, speed: 1.12, glow: true,
    desc: '活了四亿年的老家伙，鳞片像蓝玻璃。',
  },
  {
    id: 'stardust', name: '星尘海龙', rarity: 'endangered', shape: 'ribbon', tail: 'ribbon',
    pattern: 'glow', body: '#d98cff', fin: '#6a2c9e', accent: '#fff0ff',
    size: 1.8, speed: 1.2, glow: true,
    desc: '尾巴拖着星光，传说见到的人会走运。',
  },
]

export const FISH_BY_ID = Object.fromEntries(FISH_SPECIES.map((fish) => [fish.id, fish]))

export const FISH_BY_RARITY = RARITY_ORDER.reduce((acc, rarity) => {
  acc[rarity] = FISH_SPECIES.filter((fish) => fish.rarity === rarity)
  return acc
}, {})

// 成就：只从鱼库现有字段推导，不额外落盘，也不会因为清空鱼库留下脏数据。
// metric 对应 FishingGame 里算出的四个计数；target 到了就算达成。
export const ACHIEVEMENTS = [
  { id: 'first', title: '第一网', desc: '捕到 1 条鱼', metric: 'total', target: 1 },
  { id: 'five', title: '五种颜色', desc: '收齐 5 种鱼', metric: 'species', target: 5 },
  { id: 'half', title: '半部图鉴', desc: '收齐 10 种鱼', metric: 'species', target: 10 },
  { id: 'deep', title: '见过深海', desc: '捕到 1 种濒危鱼', metric: 'endangered', target: 1 },
  { id: 'words', title: '六级渔夫', desc: '拼对 25 个词', metric: 'words', target: 25 },
  { id: 'all', title: '整片海', desc: `收齐 ${FISH_SPECIES.length} 种鱼`, metric: 'species', target: FISH_SPECIES.length },
]

// 六级词库：按鱼的稀有度分五档，越长越难。
// 拼写时只给首尾字母，中间交给玩家；拼对过的词不会在同一个玩家身上再出现。
export const WORD_BANK = {
  common: [
    { word: 'absorb', hint: '吸收；理解' },
    { word: 'adapt', hint: '适应' },
    { word: 'appeal', hint: '呼吁；吸引力' },
    { word: 'assess', hint: '评估' },
    { word: 'assume', hint: '假定；承担' },
    { word: 'attach', hint: '附上；系上' },
    { word: 'aware', hint: '意识到的' },
    { word: 'boost', hint: '促进；提高' },
    { word: 'brief', hint: '简短的' },
    { word: 'budget', hint: '预算' },
    { word: 'campus', hint: '校园' },
    { word: 'career', hint: '职业；生涯' },
    { word: 'commit', hint: '承诺；犯（错）' },
    { word: 'concept', hint: '概念' },
    { word: 'confirm', hint: '确认' },
    { word: 'consume', hint: '消耗' },
    { word: 'contact', hint: '联系' },
    { word: 'context', hint: '语境；背景' },
    { word: 'contrast', hint: '对比' },
    { word: 'convert', hint: '转换' },
  ],
  rare: [
    { word: 'accurate', hint: '准确的' },
    { word: 'achieve', hint: '实现；达到' },
    { word: 'acquire', hint: '获得；习得' },
    { word: 'adequate', hint: '足够的' },
    { word: 'advocate', hint: '提倡；拥护者' },
    { word: 'allocate', hint: '分配' },
    { word: 'apparent', hint: '明显的' },
    { word: 'approach', hint: '接近；方法' },
    { word: 'approval', hint: '批准' },
    { word: 'argument', hint: '论点；争论' },
    { word: 'assembly', hint: '集会；装配' },
    { word: 'attitude', hint: '态度' },
    { word: 'boundary', hint: '边界' },
    { word: 'capacity', hint: '容量；能力' },
    { word: 'category', hint: '类别' },
    { word: 'challenge', hint: '挑战' },
    { word: 'collapse', hint: '崩溃；倒塌' },
    { word: 'comprise', hint: '包含；构成' },
    { word: 'conclude', hint: '得出结论' },
    { word: 'conduct', hint: '进行；行为' },
  ],
  precious: [
    { word: 'abundance', hint: '丰富；充裕' },
    { word: 'accelerate', hint: '加速' },
    { word: 'accomplish', hint: '完成' },
    { word: 'accumulate', hint: '积累' },
    { word: 'acknowledge', hint: '承认；致谢' },
    { word: 'adaptation', hint: '适应；改编' },
    { word: 'alternative', hint: '替代方案' },
    { word: 'ambiguous', hint: '模棱两可的' },
    { word: 'anticipate', hint: '预料' },
    { word: 'appropriate', hint: '适当的' },
    { word: 'arbitrary', hint: '任意的；武断的' },
    { word: 'architecture', hint: '建筑学；架构' },
    { word: 'assumption', hint: '假设' },
    { word: 'attribute', hint: '归因于；属性' },
    { word: 'beneficial', hint: '有益的' },
    { word: 'consequence', hint: '后果' },
    { word: 'considerable', hint: '相当大的' },
    { word: 'consistent', hint: '一致的' },
    { word: 'constraint', hint: '限制；约束' },
    { word: 'contribute', hint: '贡献；促成' },
  ],
  luxury: [
    { word: 'characteristic', hint: '特征；典型的' },
    { word: 'chronological', hint: '按时间顺序的' },
    { word: 'circumstance', hint: '情况；环境' },
    { word: 'civilization', hint: '文明' },
    { word: 'collaboration', hint: '合作' },
    { word: 'comprehensive', hint: '全面的' },
    { word: 'concentration', hint: '专注；浓度' },
    { word: 'consciousness', hint: '意识' },
    { word: 'constitutional', hint: '宪法的' },
    { word: 'contemporary', hint: '当代的' },
    { word: 'controversial', hint: '有争议的' },
    { word: 'conventional', hint: '传统的' },
    { word: 'correspondence', hint: '通信；对应' },
    { word: 'discrimination', hint: '歧视；区分' },
    { word: 'extraordinary', hint: '非凡的' },
    { word: 'fundamental', hint: '根本的' },
    { word: 'implementation', hint: '实施' },
    { word: 'infrastructure', hint: '基础设施' },
    { word: 'interpretation', hint: '解释' },
    { word: 'transformation', hint: '转变' },
  ],
  endangered: [
    { word: 'appreciation', hint: '欣赏；感激' },
    { word: 'effectiveness', hint: '有效性' },
    { word: 'indispensable', hint: '不可或缺的' },
    { word: 'investigation', hint: '调查' },
    { word: 'participation', hint: '参与' },
    { word: 'particularly', hint: '尤其' },
    { word: 'significantly', hint: '显著地' },
    { word: 'sophisticated', hint: '复杂精密的；老练的' },
    { word: 'sustainability', hint: '可持续性' },
    { word: 'accountability', hint: '问责制' },
    { word: 'environmental', hint: '环境的' },
    { word: 'conscientious', hint: '认真尽责的' },
    { word: 'consequently', hint: '因此' },
    { word: 'comprehensively', hint: '全面地' },
    { word: 'unprecedented', hint: '史无前例的' },
    { word: 'vulnerability', hint: '脆弱性' },
    { word: 'rehabilitation', hint: '康复；修复' },
    { word: 'substantial', hint: '大量的；实质的' },
    { word: 'consideration', hint: '考虑' },
    { word: 'reorganization', hint: '重组' },
  ],
}

const weightedSpecies = FISH_SPECIES.flatMap((fish) =>
  Array.from({ length: RARITIES[fish.rarity].weight }, () => fish),
)

export function randomSpecies() {
  return weightedSpecies[Math.floor(Math.random() * weightedSpecies.length)]
}

export function pickWord(rarity, usedWords) {
  const used = new Set(usedWords)
  const pool = (WORD_BANK[rarity] ?? []).filter((entry) => !used.has(entry.word))
  if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)]
  // 这一档的词全拼过了：退到全词库里找没用过的，保证「拼对过的词不重复」。
  const fallback = Object.values(WORD_BANK).flat().filter((entry) => !used.has(entry.word))
  return fallback.length > 0 ? fallback[Math.floor(Math.random() * fallback.length)] : null
}
