// 「摸鱼」小游戏的数据表：鱼种 / 稀有度 / 四六级词库。
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
  { id: 'words', title: '词汇渔夫', desc: '拼对 25 个词', metric: 'words', target: 25 },
  { id: 'all', title: '整片海', desc: `收齐 ${FISH_SPECIES.length} 种鱼`, metric: 'species', target: FISH_SPECIES.length },
]

// 四/六级词库：按鱼的稀有度分五档，越长越难。
// 拼写时只给首尾字母，中间交给玩家；拼对过的词不会在同一个玩家身上再出现。
//
// 词表来源：KyleBing/english-vocabulary 的 CET6 JSON（BSD-3-Clause，2022-2026 KyleBing），
// 只取了其中 120 个词与释义，按长度分档；没有整份复制，也没有使用百词斩的私有内容。
// 许可证全文见 public/third-party/english-vocabulary-LICENSE.txt。
// 取词范围与「百词斩六级」一致（CET-6 词汇），但具体词条以这份开源表为准。
export const WORD_BANK = {
  common: [
    { word: 'abuse', hint: '滥用；虐待' },
    { word: 'adopt', hint: '采用；收养' },
    { word: 'alert', hint: '警觉的；提醒' },
    { word: 'alien', hint: '外国的；陌生的' },
    { word: 'ankle', hint: '脚踝' },
    { word: 'bias', hint: '偏见' },
    { word: 'blame', hint: '谴责；责怪' },
    { word: 'boost', hint: '促进；提高' },
    { word: 'breed', hint: '繁殖；培育' },
    { word: 'bribe', hint: '贿赂' },
    { word: 'chain', hint: '链条；连锁店' },
    { word: 'chaos', hint: '混乱' },
    { word: 'claim', hint: '声称；主张' },
    { word: 'clue', hint: '线索' },
    { word: 'code', hint: '代码；密码' },
    { word: 'cover', hint: '覆盖；报道' },
    { word: 'curb', hint: '控制；约束' },
    { word: 'dare', hint: '敢于' },
    { word: 'deem', hint: '认为；视为' },
    { word: 'defy', hint: '违抗；蔑视' },
    { word: 'draft', hint: '草稿；起草' },
    { word: 'drift', hint: '漂流；漂移' },
    { word: 'fatal', hint: '致命的' },
    { word: 'flaw', hint: '缺点；瑕疵' },
  ],
  rare: [
    { word: 'accuse', hint: '指责；控告' },
    { word: 'achieve', hint: '达到；实现' },
    { word: 'adverse', hint: '不利的' },
    { word: 'agenda', hint: '议程' },
    { word: 'anxiety', hint: '焦虑' },
    { word: 'appoint', hint: '任命；约定' },
    { word: 'approve', hint: '批准；赞成' },
    { word: 'aspect', hint: '方面' },
    { word: 'barrier', hint: '障碍；屏障' },
    { word: 'bitter', hint: '苦的；痛苦的' },
    { word: 'bizarre', hint: '怪诞的' },
    { word: 'burden', hint: '负担；重担' },
    { word: 'clarify', hint: '澄清' },
    { word: 'consult', hint: '咨询；查阅' },
    { word: 'crisis', hint: '危机' },
    { word: 'decay', hint: '腐烂；衰退' },
    { word: 'decline', hint: '下降；衰退' },
    { word: 'devote', hint: '奉献' },
    { word: 'dismiss', hint: '解雇；驳回' },
    { word: 'diverse', hint: '多样的' },
    { word: 'endure', hint: '忍受；持续' },
    { word: 'enhance', hint: '提高；加强' },
    { word: 'evolve', hint: '进化；演变' },
    { word: 'exceed', hint: '超过' },
  ],
  precious: [
    { word: 'abstract', hint: '抽象的' },
    { word: 'accurate', hint: '准确的' },
    { word: 'activate', hint: '激活' },
    { word: 'adventure', hint: '冒险' },
    { word: 'affection', hint: '感情；喜爱' },
    { word: 'aggravate', hint: '加剧；恶化' },
    { word: 'anonymous', hint: '匿名的' },
    { word: 'apartment', hint: '公寓' },
    { word: 'apologize', hint: '道歉' },
    { word: 'applicant', hint: '申请者' },
    { word: 'arrogant', hint: '傲慢的' },
    { word: 'assemble', hint: '集合；装配' },
    { word: 'athletic', hint: '运动的' },
    { word: 'authority', hint: '权威；权力' },
    { word: 'automatic', hint: '自动的' },
    { word: 'available', hint: '可用的' },
    { word: 'awareness', hint: '意识' },
    { word: 'bacteria', hint: '细菌' },
    { word: 'biography', hint: '传记' },
    { word: 'capacity', hint: '容量；能力' },
    { word: 'cautious', hint: '谨慎的' },
    { word: 'coherent', hint: '连贯的；一致的' },
    { word: 'compile', hint: '汇编；编制' },
    { word: 'concede', hint: '承认；让步' },
  ],
  luxury: [
    { word: 'abandonment', hint: '放弃' },
    { word: 'accelerate', hint: '加速' },
    { word: 'accomplish', hint: '完成' },
    { word: 'accountant', hint: '会计' },
    { word: 'alternative', hint: '替代方案；可选的' },
    { word: 'analytical', hint: '分析的' },
    { word: 'anticipate', hint: '预料；预期' },
    { word: 'applicable', hint: '适用的' },
    { word: 'appropriate', hint: '适当的' },
    { word: 'artificial', hint: '人工的；人造的' },
    { word: 'assessment', hint: '评估' },
    { word: 'association', hint: '协会；关联' },
    { word: 'atmosphere', hint: '大气；氛围' },
    { word: 'bureaucracy', hint: '官僚机构' },
    { word: 'calculation', hint: '计算' },
    { word: 'circulation', hint: '循环；流通' },
    { word: 'collective', hint: '集体的；共同的' },
    { word: 'commitment', hint: '承诺；投入' },
    { word: 'compelling', hint: '引人注目的；有说服力的' },
    { word: 'compensate', hint: '补偿' },
    { word: 'competitive', hint: '竞争的；有竞争力的' },
    { word: 'compromise', hint: '妥协' },
    { word: 'concentrate', hint: '集中；专注' },
    { word: 'conception', hint: '概念；构想' },
  ],
  endangered: [
    { word: 'acquaintance', hint: '熟人；认识' },
    { word: 'administration', hint: '管理；行政' },
    { word: 'approximately', hint: '大约' },
    { word: 'authorization', hint: '授权' },
    { word: 'breakthrough', hint: '突破' },
    { word: 'circumstance', hint: '情况；环境' },
    { word: 'collaborative', hint: '合作的' },
    { word: 'comprehensive', hint: '全面的；综合的' },
    { word: 'conservation', hint: '保护；保存' },
    { word: 'conservative', hint: '保守的' },
    { word: 'considerable', hint: '相当大的' },
    { word: 'construction', hint: '建造；建筑' },
    { word: 'contamination', hint: '污染' },
    { word: 'contribution', hint: '贡献' },
    { word: 'conventional', hint: '传统的；常规的' },
    { word: 'coordination', hint: '协调' },
    { word: 'disadvantage', hint: '缺点；不利条件' },
    { word: 'distribution', hint: '分配；分布' },
    { word: 'dramatically', hint: '大幅度地' },
    { word: 'extraordinary', hint: '非凡的；特别的' },
    { word: 'indispensable', hint: '不可或缺的' },
    { word: 'interpretation', hint: '解释；理解' },
    { word: 'intervention', hint: '干预；介入' },
    { word: 'predominantly', hint: '主要地；占主导地位地' },
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
