import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { isImeComposing } from '../lib/ime'
import FishShape from './FishShape'
import {
  ACHIEVEMENTS,
  FISH_BY_ID,
  FISH_BY_RARITY,
  FISH_SPECIES,
  RARITIES,
  RARITY_ORDER,
  WORD_BANK,
  pickWord,
  randomSpecies,
} from './fishingData'

// ── 「摸鱼」────────────────────────────────────────────────────────
// 玩法：拖动海面瞄准，松手把网撒出去；网口碰到鱼就咬钩，接着拼一个
// 四/六级单词（首尾字母给出）才算入账。拼错鱼会跑掉，拼对过的词不再出现。
// 20 种鱼分五档稀有度，越稀有越小、越快、分越高。
//
// 数据边界（实验室规矩）：
//   · 鱼库只写本机 localStorage，按用户 id 分开；
//   · 在线渔友走 Supabase Realtime presence，不建表、不写库；
//   · 不读动态、私聊或任何密钥。
const VIEW_W = 800
const VIEW_H = 660
const ORIGIN = { x: VIEW_W / 2, y: 620 }
const MAX_RANGE = 560
const NET_SPEED = 980
const NET_START = 34
const AIM_LIMIT = 1.38
const FISH_TARGET = 8
const STORAGE_PREFIX = 'moments-fishing-v1:'
const FRIEND_STORAGE_PREFIX = 'moments-fishing-friend-v1:'
// 固定鱼友的 presence 快照只按「查看者」落本机：换账号登录不会串数据。
const PAL_SNAPSHOT_PREFIX = 'moments-fishing-pal-v1:'
const LOBBY_CHANNEL = 'moments-fishing-lobby-v1'
// 公共频道里最多显示这么多人，防止有人刷屏把页面撑爆。
const MAX_LOBBY = 24
const COUNT_CAP = 999999

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function sanitizeCount(value, cap = COUNT_CAP) {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.min(number, cap)
}

function sanitizeCaught(input) {
  const caught = {}
  if (!input || typeof input !== 'object') return caught
  for (const fish of FISH_SPECIES) {
    const count = sanitizeCount(input[fish.id], 9999)
    if (count > 0) caught[fish.id] = count
  }
  return caught
}

const WORD_RE = /^[a-z]{3,24}$/
const MAX_WORDS_PER_FISH = 40
// 旧版词库（换成四六级 120 词之前）拼过的词还可能留在本机鱼库里。
// 这里保留旧词释义，保证旧数据在鱼种详情里也能看到中文，而不是只剩英文。
const LEGACY_WORD_HINTS = {
  absorb: '吸收；理解',
  abundance: '丰富；充裕',
  accountability: '问责制',
  accumulate: '积累',
  acknowledge: '承认；致谢',
  acquire: '获得；习得',
  adapt: '适应',
  adaptation: '适应；改编',
  adequate: '足够的',
  advocate: '提倡；拥护者',
  allocate: '分配',
  ambiguous: '模棱两可的',
  apparent: '明显的',
  appeal: '呼吁；吸引力',
  appreciation: '欣赏；感激',
  approach: '接近；方法',
  approval: '批准',
  arbitrary: '任意的；武断的',
  architecture: '建筑学；架构',
  argument: '论点；争论',
  assembly: '集会；装配',
  assess: '评估',
  assume: '假定；承担',
  assumption: '假设',
  attach: '附上；系上',
  attitude: '态度',
  attribute: '归因于；属性',
  aware: '意识到的',
  beneficial: '有益的',
  boundary: '边界',
  brief: '简短的',
  budget: '预算',
  campus: '校园',
  career: '职业；生涯',
  category: '类别',
  challenge: '挑战',
  characteristic: '特征；典型的',
  chronological: '按时间顺序的',
  civilization: '文明',
  collaboration: '合作',
  collapse: '崩溃；倒塌',
  commit: '承诺；犯（错）',
  comprehensively: '全面地',
  comprise: '包含；构成',
  concentration: '专注；浓度',
  concept: '概念',
  conclude: '得出结论',
  conduct: '进行；行为',
  confirm: '确认',
  conscientious: '认真尽责的',
  consciousness: '意识',
  consequence: '后果',
  consequently: '因此',
  consideration: '考虑',
  consistent: '一致的',
  constitutional: '宪法的',
  constraint: '限制；约束',
  consume: '消耗',
  contact: '联系',
  contemporary: '当代的',
  context: '语境；背景',
  contrast: '对比',
  contribute: '贡献；促成',
  controversial: '有争议的',
  convert: '转换',
  correspondence: '通信；对应',
  discrimination: '歧视；区分',
  effectiveness: '有效性',
  environmental: '环境的',
  fundamental: '根本的',
  implementation: '实施',
  infrastructure: '基础设施',
  investigation: '调查',
  participation: '参与',
  particularly: '尤其',
  rehabilitation: '康复；修复',
  reorganization: '重组',
  significantly: '显著地',
  sophisticated: '复杂精密的；老练的',
  substantial: '大量的；实质的',
  sustainability: '可持续性',
  transformation: '转变',
  unprecedented: '史无前例的',
  vulnerability: '脆弱性',
}
// 「拼对」明细用：词 → 中文提示。旧词先铺底，当前词库覆盖同名项。
const WORD_HINTS = new Map([
  ...Object.entries(LEGACY_WORD_HINTS),
  ...Object.values(WORD_BANK).flat().map((entry) => [entry.word, entry.hint]),
])

function normalizeWord(value) {
  const word = String(value ?? '').trim().toLowerCase()
  return WORD_RE.test(word) ? word : ''
}

function wordHint(word) {
  return WORD_HINTS.get(normalizeWord(word)) ?? ''
}

// 鱼库里的「鱼种 → 拼对过的单词」。旧版本没有这个字段，读到空对象即可；
// 详情页会退回显示同稀有度拼过的单词，不会把旧数据丢掉。
function sanitizeWordsByFish(input) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  for (const fish of FISH_SPECIES) {
    const list = input[fish.id]
    if (!Array.isArray(list)) continue
    const seen = new Set()
    const words = []
    for (const raw of list) {
      const word = normalizeWord(raw)
      if (!word || seen.has(word)) continue
      seen.add(word)
      words.push(word)
      if (words.length >= MAX_WORDS_PER_FISH) break
    }
    if (words.length > 0) out[fish.id] = words
  }
  return out
}

// presence 是公共频道，只带每个鱼种最近拼对的一个词，够渔友点开详情看；
// 不广播完整词库，也不广播任何账号信息。
function latestWordByFish(wordsByFish) {
  const out = {}
  for (const fish of FISH_SPECIES) {
    const words = wordsByFish?.[fish.id]
    if (!Array.isArray(words) || words.length === 0) continue
    const word = normalizeWord(words[words.length - 1])
    if (word) out[fish.id] = word
  }
  return out
}

function sanitizePresenceWords(input) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  for (const fish of FISH_SPECIES) {
    const word = normalizeWord(input[fish.id])
    if (word) out[fish.id] = word
  }
  return out
}

function wordsForFish(library, species) {
  const exact = library.wordsByFish?.[species.id]
  if (Array.isArray(exact) && exact.length > 0) return { words: exact, exact: true }
  // 旧鱼库没有鱼种→单词映射：退到「同稀有度拼过的词」，并在文案里说清楚。
  const pool = new Set((WORD_BANK[species.rarity] ?? []).map((entry) => entry.word))
  const fallback = [...new Set((library.usedWords ?? []).filter((word) => pool.has(word)))]
  return { words: fallback, exact: false }
}

// presence 的 key 用一次性的会话 id，而不是账号 id：
// 公共频道里的 key 和 metadata 对所有订阅者可见，不该把 auth uid 摊出去。
function createSessionId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  } catch {
    /* 老浏览器没有 randomUUID，走下面的兜底 */
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function emptyLibrary() {
  return { v: 2, points: 0, total: 0, caught: {}, usedWords: [], wordsByFish: {} }
}

function loadLibrary(userId) {
  if (!userId) return emptyLibrary()
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${userId}`)
    if (!raw) return emptyLibrary()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return emptyLibrary()
    return {
      // v1 → v2：usedWords 保留，wordsByFish 从空映射开始；新捕到的鱼会补上对应单词。
      v: 2,
      points: sanitizeCount(parsed.points),
      total: sanitizeCount(parsed.total),
      caught: sanitizeCaught(parsed.caught),
      usedWords: Array.isArray(parsed.usedWords)
        ? parsed.usedWords.filter((w) => typeof w === 'string' && /^[a-z]+$/i.test(w)).slice(0, 500)
        : [],
      wordsByFish: sanitizeWordsByFish(parsed.wordsByFish),
    }
  } catch {
    return emptyLibrary()
  }
}

function saveLibrary(userId, library) {
  if (!userId) return
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${userId}`, JSON.stringify(library))
  } catch {
    /* 隐私模式下 localStorage 可能写不了，游戏继续，只是不落盘 */
  }
}

// 「鱼友」固定成对方：第一次确认（这个圈子只有两位真人）后在本机记下来，
// 之后就算有人注册了测试号，也不会把鱼友换掉。换设备会重新确认一次。
function loadFriendProfile(userId) {
  if (!userId) return null
  try {
    const raw = localStorage.getItem(`${FRIEND_STORAGE_PREFIX}${userId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.nickname !== 'string') return null
    return { id: parsed.id, nickname: parsed.nickname.slice(0, 20) }
  } catch {
    return null
  }
}

function saveFriendProfile(userId, friend) {
  if (!userId || !friend) return
  try {
    localStorage.setItem(`${FRIEND_STORAGE_PREFIX}${userId}`, JSON.stringify({
      id: friend.id,
      nickname: friend.nickname,
    }))
  } catch {
    /* 写不了就算了，下次重新确认 */
  }
}

function sanitizeSyncTime(value) {
  const time = Math.floor(Number(value))
  if (!Number.isFinite(time) || time <= 0) return 0
  // 本机手改 localStorage 也不该出现"未来"的同步时间。
  return Math.min(time, Date.now() + 86400000)
}

function formatSyncTime(value) {
  const time = sanitizeSyncTime(value)
  if (!time) return ''
  const date = new Date(time)
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 固定鱼友在线时，把公共 presence 里那份只读快照按查看者账号落本机。
// 离线时用它渲染；不落账号 id、不建表、不写库。
function snapshotFromPresence(friend, player) {
  return {
    v: 1,
    friendId: friend.id,
    name: (player.name || friend.nickname || '匿名渔夫').slice(0, 20),
    points: sanitizeCount(player.points),
    total: sanitizeCount(player.total),
    caught: sanitizeCaught(player.caught),
    wordCount: sanitizeCount(player.wordCount),
    words: sanitizePresenceWords(player.words),
    syncedAt: Date.now(),
  }
}

function loadPalSnapshot(userId, friendId) {
  if (!userId || !friendId) return null
  try {
    const raw = localStorage.getItem(`${PAL_SNAPSHOT_PREFIX}${userId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || parsed.friendId !== friendId) return null
    const syncedAt = sanitizeSyncTime(parsed.syncedAt)
    if (!syncedAt) return null
    return {
      v: 1,
      friendId,
      name: typeof parsed.name === 'string' ? parsed.name.slice(0, 20) : '',
      points: sanitizeCount(parsed.points),
      total: sanitizeCount(parsed.total),
      caught: sanitizeCaught(parsed.caught),
      wordCount: sanitizeCount(parsed.wordCount),
      words: sanitizePresenceWords(parsed.words),
      syncedAt,
    }
  } catch {
    return null
  }
}

function savePalSnapshot(userId, snapshot) {
  if (!userId || !snapshot?.friendId) return
  try {
    localStorage.setItem(`${PAL_SNAPSHOT_PREFIX}${userId}`, JSON.stringify(snapshot))
  } catch {
    /* 隐私模式/配额满：下海照常，只是离线时没有快照兜底 */
  }
}

function caughtSpeciesCount(caught) {
  return FISH_SPECIES.reduce((sum, fish) => sum + (caught?.[fish.id] > 0 ? 1 : 0), 0)
}

function totalFishCount(caught) {
  return Object.values(caught ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0)
}

function pointsFor(species) {
  return RARITIES[species.rarity]?.points ?? 10
}

function withCatch(library, species, word) {
  const points = pointsFor(species)
  const wordsByFish = { ...(library.wordsByFish ?? {}) }
  if (word) {
    const list = Array.isArray(wordsByFish[species.id]) ? wordsByFish[species.id] : []
    if (!list.includes(word)) wordsByFish[species.id] = [...list, word].slice(-MAX_WORDS_PER_FISH)
  }
  return {
    ...library,
    v: 2,
    points: library.points + points,
    total: library.total + 1,
    caught: { ...library.caught, [species.id]: (library.caught[species.id] ?? 0) + 1 },
    usedWords: word ? [...library.usedWords, word] : library.usedWords,
    wordsByFish,
  }
}

// 把当前鱼库压缩成 presence 元数据：只带昵称/战绩/每个鱼种最近拼对的一个词，
// 不带账号 id，也不带完整词库。
function presenceMeta(sessionId, nickname, library) {
  return {
    sid: sessionId,
    name: (nickname || '匿名渔夫').slice(0, 20),
    points: sanitizeCount(library.points),
    total: sanitizeCount(library.total),
    caught: sanitizeCaught(library.caught),
    // 渔友只需要知道「拼对了多少个」，不需要整份词表。
    wordCount: sanitizeCount(new Set(library.usedWords).size),
    words: latestWordByFish(library.wordsByFish),
    ts: Date.now(),
  }
}

// presence 是公共频道，任何能订阅的人都能伪造 metadata；展示前一律重新收口。
function sanitizePresence(raw, selfSid) {
  if (!raw || typeof raw !== 'object') return null
  const sid = typeof raw.sid === 'string' ? raw.sid.slice(0, 80) : ''
  if (!sid || sid === selfSid) return null
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 20) : ''
  return {
    sid,
    name: name || '匿名渔夫',
    points: sanitizeCount(raw.points),
    total: sanitizeCount(raw.total),
    caught: sanitizeCaught(raw.caught),
    wordCount: sanitizeCount(raw.wordCount),
    words: sanitizePresenceWords(raw.words),
    ts: Number(raw.ts) || 0,
  }
}

// ── 画鱼 / 鱼库小卡 ────────────────────────────────────────────────
function FishThumb({ species, muted = false, className = '' }) {
  return (
    <svg className={`fish-thumb ${className}`} viewBox="-175 -125 350 250" aria-hidden="true">
      <FishShape species={species} muted={muted} />
    </svg>
  )
}

function RarityChip({ rarity }) {
  const meta = RARITIES[rarity]
  return (
    <span className="fishing-rarity-chip" style={{ '--rarity-color': meta.color }}>
      <span aria-hidden="true" />
      {meta.label}
    </span>
  )
}

const FishingLibrary = memo(function FishingLibrary({ library, onDetail = null, ownerLabel = '我的鱼库' }) {
  const owned = caughtSpeciesCount(library.caught)
  const completion = Math.round((owned / FISH_SPECIES.length) * 100)
  return (
    <section className="fishing-library" aria-label={ownerLabel}>
      <div className="fishing-section-head">
        <h3>{ownerLabel}</h3>
        <span>{owned} / {FISH_SPECIES.length} 种 · {totalFishCount(library.caught)} 条</span>
      </div>
      <div
        className="fishing-progress"
        role="progressbar"
        aria-label={`${ownerLabel}完成度`}
        aria-valuemin={0}
        aria-valuemax={FISH_SPECIES.length}
        aria-valuenow={owned}
        aria-valuetext={`${owned} / ${FISH_SPECIES.length} 种，${completion}%`}
      >
        <span style={{ width: `${completion}%` }} />
      </div>
      <div className="fishing-rarity-legend">
        {RARITY_ORDER.map((rarity) => (
          <RarityChip key={rarity} rarity={rarity} />
        ))}
      </div>
      {RARITY_ORDER.map((rarity) => {
        const meta = RARITIES[rarity]
        const speciesList = FISH_BY_RARITY[rarity]
        const caughtHere = speciesList.filter((fish) => library.caught[fish.id] > 0).length
        return (
          <div className="fishing-shelf" key={rarity}>
            <div className="fishing-shelf-head">
              <span className="fishing-shelf-title" style={{ '--rarity-color': meta.color }}>
                <span aria-hidden="true" />
                {meta.label}
              </span>
              <span className="fishing-shelf-count">{caughtHere} / {speciesList.length}</span>
            </div>
            <div className="fishing-grid">
              {speciesList.map((fish) => {
                const count = library.caught[fish.id] ?? 0
                const unlocked = count > 0
                const content = (
                  <>
                    <span className="fish-card-visual">
                      <FishThumb species={fish} muted={!unlocked} />
                    </span>
                    <span className="fish-card-name">{fish.name}</span>
                    <span className="fish-card-count">{unlocked ? `×${count}` : '未捕获'}</span>
                  </>
                )
                const className = `fish-card${unlocked ? ' is-owned' : ' is-locked'}`
                const label = `${fish.name}，${meta.label}，${unlocked ? `已捕获 ${count} 条` : '未捕获'}`
                return onDetail ? (
                  <button
                    key={fish.id}
                    type="button"
                    className={className}
                    style={{ '--fish-body': fish.body, '--rarity-color': meta.color }}
                    onClick={() => onDetail(fish)}
                    aria-label={label}
                  >
                    {content}
                  </button>
                ) : (
                  <div
                    key={fish.id}
                    className={className}
                    style={{ '--fish-body': fish.body, '--rarity-color': meta.color }}
                    aria-label={label}
                  >
                    {content}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </section>
  )
})

// ── 拼写面板 ──────────────────────────────────────────────────────
// 一个字母一个框：首尾固定显示，中间的框逐格输入、自动跳格、退格回上一格。
// 填错的格子立刻标红、填对标绿；不锁死，可以反复改，直到自己点「放生」。
function SpellPanel({ pending, letters, onChange, state, onSubmit, onGiveUp, onClose }) {
  const full = pending.word.word
  const middle = full.slice(1, -1)
  const meta = RARITIES[pending.species.rarity]
  const points = pointsFor(pending.species)
  const done = state === 'ok'
  const inputsRef = useRef([])
  const allFilled = letters.length === middle.length && letters.every((letter) => letter.length === 1)
  const allCorrect = allFilled && middle.split('').every((letter, index) => letters[index] === letter)

  useEffect(() => {
    // 打开面板就把焦点放到第一个空格；捕到的词最短 3 个字母，中间至少 1 格。
    if (!done) inputsRef.current[0]?.focus()
  }, [done])

  const focusAt = (index) => {
    const target = inputsRef.current[Math.max(0, Math.min(index, middle.length - 1))]
    target?.focus()
    target?.select?.()
  }

  const writeLetters = (next, focusIndex) => {
    onChange(next)
    if (focusIndex !== null) focusAt(focusIndex)
  }

  const applyText = (index, raw) => {
    const clean = String(raw ?? '').replace(/[^a-zA-Z]/g, '').toLowerCase()
    const next = [...letters]
    if (!clean) {
      next[index] = ''
      writeLetters(next, index)
      return
    }
    // 粘贴/输入法一次给了整串：从当前格开始铺，铺满为止。
    const spread = clean.split('')
    for (let cursor = index; cursor < middle.length && spread.length > 0; cursor += 1) {
      next[cursor] = spread.shift()
    }
    writeLetters(next, Math.min(index + clean.length, middle.length - 1))
  }

  const onLetterChange = (index, event) => {
    const raw = event.target.value
    applyText(index, raw)
  }

  const onLetterKeyDown = (index, event) => {
    // 中文键盘打英文时，回车先用于确认候选词；这里不能顺手提交。
    if (event.key === 'Enter' && isImeComposing(event)) return
    if (event.key === 'Backspace') {
      if (letters[index]) {
        const next = [...letters]
        next[index] = ''
        writeLetters(next, index)
      } else if (index > 0) {
        event.preventDefault()
        const next = [...letters]
        next[index - 1] = ''
        writeLetters(next, index - 1)
      }
      return
    }
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault()
      focusAt(index - 1)
    } else if (event.key === 'ArrowRight' && index < middle.length - 1) {
      event.preventDefault()
      focusAt(index + 1)
    }
  }

  const onLetterPaste = (index, event) => {
    const text = event.clipboardData?.getData('text') ?? ''
    if (!text) return
    event.preventDefault()
    let clean = text.replace(/[^a-zA-Z]/g, '').toLowerCase()
    // 允许直接粘贴整词：首尾字母与题目一致时去掉，只填中间。
    if (clean.length === full.length && clean[0] === full[0] && clean.at(-1) === full.at(-1)) {
      clean = clean.slice(1, -1)
    }
    applyText(index, clean)
  }

  const handleSubmit = (event) => {
    event.preventDefault()
    if (state === 'ok') {
      onClose()
      return
    }
    if (!allFilled) {
      const firstEmpty = middle.split('').findIndex((_, index) => !letters[index])
      focusAt(firstEmpty >= 0 ? firstEmpty : 0)
      return
    }
    if (!allCorrect) {
      const firstWrong = middle.split('').findIndex((letter, index) => letters[index] !== letter)
      focusAt(firstWrong >= 0 ? firstWrong : 0)
      onSubmit(false)
      return
    }
    onSubmit(true)
  }

  return (
    <div className="fishing-modal-backdrop" role="presentation" onPointerDown={onGiveUp}>
      <div
        className="fishing-modal fishing-spell"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fishing-spell-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="fishing-spell-fish">
          <FishThumb species={pending.species} />
        </div>
        <p className="fishing-eyebrow">咬钩了 · {meta.label}</p>
        <h3 id="fishing-spell-title">{pending.species.name}</h3>
        <p className="fishing-spell-hint">{pending.word.hint}</p>

        <form onSubmit={handleSubmit}>
          <div
            className={`fishing-spell-word${state === 'wrong' ? ' is-wrong' : ''}${state === 'ok' ? ' is-ok' : ''}`}
            role="group"
            aria-label={`拼出 ${pending.species.name} 对应的单词，首字母 ${full[0]}，尾字母 ${full.at(-1)}，中间 ${middle.length} 个字母`}
          >
            <span className="fishing-letter-box is-fixed" aria-hidden="true">{full[0]}</span>
            {middle.split('').map((expected, index) => {
              const letter = letters[index] ?? ''
              const status = letter ? (letter === expected ? ' is-correct' : ' is-wrong') : ''
              return (
                <input
                  key={index}
                  ref={(node) => { inputsRef.current[index] = node }}
                  className={`fishing-letter-box${status}`}
                  value={letter}
                  onChange={(event) => onLetterChange(index, event)}
                  onKeyDown={(event) => onLetterKeyDown(index, event)}
                  onPaste={(event) => onLetterPaste(index, event)}
                  onFocus={(event) => event.target.select()}
                  maxLength={1}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint={index === middle.length - 1 ? 'done' : 'next'}
                  aria-label={`第 ${index + 1} 个字母，共 ${middle.length} 个`}
                  aria-invalid={letter ? letter !== expected : undefined}
                  disabled={done}
                />
              )
            })}
            <span className="fishing-letter-box is-fixed" aria-hidden="true">{full.at(-1)}</span>
          </div>

          <p className="fishing-spell-meta">
            CET-6 词 · 共 {full.length} 个字母 · 首尾已给出 · 拼对 +{points} 分
          </p>

          {state === 'wrong' && (
            <p className="fishing-spell-result is-bad" role="alert">
              还有字母不对。红色的格子改对后再确认；不想拼了就点「放生」。
            </p>
          )}
          {state === 'ok' && (
            <p className="fishing-spell-result is-good">拼写正确，{pending.species.name}已收进鱼库，+{points} 分</p>
          )}

          <div className="fishing-spell-actions">
            {!done ? (
              <>
                <button type="button" className="fishing-btn is-ghost" onClick={onGiveUp}>放生</button>
                <button type="submit" className="fishing-btn is-primary" disabled={!allFilled}>确认拼写</button>
              </>
            ) : (
              <button type="button" className="fishing-btn is-primary" onClick={onClose}>继续摸鱼</button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}

// ── 鱼种详情 ──────────────────────────────────────────────────────
function FishDetail({
  species,
  count,
  words = [],
  wordsLabel = '拼出过的单词',
  emptyNote = '',
  onClose,
}) {
  const meta = RARITIES[species.rarity]
  return (
    <div className="fishing-modal-backdrop" role="presentation" onPointerDown={onClose}>
      <div
        className="fishing-modal fishing-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fishing-detail-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="fishing-modal-close" onClick={onClose} aria-label="关闭">×</button>
        <div className="fishing-detail-fish">
          <FishThumb species={species} muted={count === 0} />
        </div>
        <RarityChip rarity={species.rarity} />
        <h3 id="fishing-detail-title">{species.name}</h3>
        <p className="fishing-detail-desc">{species.desc}</p>
        <div className="fishing-detail-stats">
          <span><small>积分</small><strong>{meta.points}</strong></span>
          <span><small>已捕获</small><strong>{count > 0 ? `${count} 条` : '还没有'}</strong></span>
          <span><small>难度</small><strong>{meta.label}</strong></span>
        </div>
        <div className="fishing-detail-words">
          <div className="fishing-detail-words-head">
            <small>{words.length > 0 ? wordsLabel : '对应单词'}</small>
            {words.length > 0 && <span>{words.length} 个</span>}
          </div>
          {words.length > 0 ? (
            <div className="fishing-word-list">
              {words.map((word) => {
                const hint = wordHint(word)
                return (
                  <span className="fishing-word" key={word}>
                    <strong>{word}</strong>
                    <small>{hint || '暂无释义'}</small>
                  </span>
                )
              })}
            </div>
          ) : (
            <p className="fishing-detail-words-empty">{emptyNote}</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 渔友鱼库 ──────────────────────────────────────────────────────
function PlayerLibrary({ player, onClose, onDetail }) {
  const library = {
    points: player.points,
    total: player.total,
    caught: player.caught ?? {},
    usedWords: [],
    wordsByFish: {},
  }
  const online = player.online !== false
  const syncedAt = online ? 0 : sanitizeSyncTime(player.syncedAt)
  const hasSnapshot = Boolean(syncedAt)
  const syncLabel = hasSnapshot ? formatSyncTime(syncedAt) : ''
  return (
    <div className="fishing-modal-backdrop" role="presentation" onPointerDown={onClose}>
      <div
        className="fishing-modal fishing-player-library"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fishing-player-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="fishing-modal-close" onClick={onClose} aria-label="关闭">×</button>
        <div className="fishing-player-head">
          <span className="fishing-player-avatar" aria-hidden="true">{player.name.slice(0, 1)}</span>
          <div>
            <p className="fishing-eyebrow">
              {online ? '在线渔友' : hasSnapshot ? '渔友 · 离线快照' : '渔友 · 当前离线'}
            </p>
            <h3 id="fishing-player-title">{player.name}</h3>
            <p>
              {online
                ? `${player.points ?? 0} 分 · 已捕 ${player.total ?? 0} 条 · 拼对 ${player.wordCount ?? 0} 个词`
                : hasSnapshot
                  ? `上次同步 ${syncLabel} · ${player.points ?? 0} 分 · 已捕 ${player.total ?? 0} 条 · 拼对 ${player.wordCount ?? 0} 个词`
                  : '对方还没打开摸鱼，鱼库和拼对单词数要等 TA 上线后同步。'}
            </p>
          </div>
        </div>
        {online || hasSnapshot ? (
          <>
            {hasSnapshot && (
              <p className="fishing-sync-note">
                这是 TA 上次在线时的鱼库快照；TA 再打开摸鱼就会换成实时数据。
              </p>
            )}
            <FishingLibrary library={library} ownerLabel={`${player.name} 的鱼库`} onDetail={onDetail} />
          </>
        ) : (
          <p className="fishing-player-offline">
            这个渔友是固定的：你看到的是对方；等 TA 打开「摸鱼」，这里就会出现 TA 的鱼库。
          </p>
        )}
      </div>
    </div>
  )
}

// ── 本机明细浮层：鱼库 / 已捕 / 拼对 ──────────────────────────────
function LibraryDialog({ library, onClose, onDetail }) {
  return (
    <div className="fishing-modal-backdrop" role="presentation" onPointerDown={onClose}>
      <div
        className="fishing-modal fishing-list-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fishing-library-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="fishing-modal-close" onClick={onClose} aria-label="关闭">×</button>
        <h3 id="fishing-library-title" className="fishing-list-title">我的鱼库</h3>
        <FishingLibrary library={library} ownerLabel="我的鱼库" onDetail={onDetail} />
      </div>
    </div>
  )
}

function CaughtDialog({ library, onClose, onDetail }) {
  const caught = FISH_SPECIES
    .filter((species) => (library.caught[species.id] ?? 0) > 0)
    .sort((a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity))
  const total = totalFishCount(library.caught)
  return (
    <div className="fishing-modal-backdrop" role="presentation" onPointerDown={onClose}>
      <div
        className="fishing-modal fishing-list-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fishing-caught-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="fishing-modal-close" onClick={onClose} aria-label="关闭">×</button>
        <div className="fishing-list-head">
          <h3 id="fishing-caught-title">已捕</h3>
          <span>{caught.length} 种 · {total} 条</span>
        </div>
        {caught.length > 0 ? (
          <div className="fishing-caught-list">
            {caught.map((species) => {
              const meta = RARITIES[species.rarity]
              const count = library.caught[species.id] ?? 0
              return (
                <button
                  key={species.id}
                  type="button"
                  className="fishing-caught-row"
                  style={{ '--fish-body': species.body, '--rarity-color': meta.color }}
                  onClick={() => onDetail(species)}
                  aria-label={`${species.name}，${meta.label}，已捕获 ${count} 条，查看详情`}
                >
                  <span className="fishing-caught-thumb"><FishThumb species={species} /></span>
                  <span className="fishing-caught-copy">
                    <strong>{species.name}</strong>
                    <small>{meta.label} · ×{count}</small>
                  </span>
                  <span className="fishing-caught-go" aria-hidden="true">详情 →</span>
                </button>
              )
            })}
          </div>
        ) : (
          <p className="fishing-list-empty">还没有捕到鱼。去海面下网，拼对单词就能收进鱼库。</p>
        )}
      </div>
    </div>
  )
}

function WordsDialog({ library, onClose }) {
  const words = [...new Set(library.usedWords)].sort((a, b) => a.localeCompare(b))
  return (
    <div className="fishing-modal-backdrop" role="presentation" onPointerDown={onClose}>
      <div
        className="fishing-modal fishing-list-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fishing-words-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button type="button" className="fishing-modal-close" onClick={onClose} aria-label="关闭">×</button>
        <div className="fishing-list-head">
          <h3 id="fishing-words-title">拼对</h3>
          <span>{words.length} 个词</span>
        </div>
        {words.length > 0 ? (
          <div className="fishing-words-list">
            {words.map((word) => (
              <div className="fishing-words-row" key={word}>
                <strong>{word}</strong>
                <small>{wordHint(word) || '暂无释义'}</small>
              </div>
            ))}
          </div>
        ) : (
          <p className="fishing-list-empty">还没有拼对过单词。抓鱼后按字母格拼出来，就会记在这里。</p>
        )}
      </div>
    </div>
  )
}

// ── 成就 ──────────────────────────────────────────────────────────
const FishingAchievements = memo(function FishingAchievements({ items }) {
  const done = items.filter((item) => item.done).length
  return (
    <section className="fishing-achievements" aria-label="摸鱼成就">
      <div className="fishing-section-head">
        <h3>摸鱼成就</h3>
        <span>{done} / {items.length} 枚</span>
      </div>
      <div className="fishing-ach-grid">
        {items.map((item) => {
          const percent = Math.min(100, Math.round((item.value / item.target) * 100))
          return (
            <div
              key={item.id}
              className={`fishing-ach${item.done ? ' is-done' : ''}`}
              aria-label={`${item.title}，${item.done ? '已达成' : `进度 ${item.value} / ${item.target}`}，${item.desc}`}
            >
              <span className="fishing-ach-medal" aria-hidden="true">{item.done ? '✓' : '○'}</span>
              <span className="fishing-ach-copy">
                <strong>{item.title}</strong>
                <small>{item.done ? '已达成' : `${item.value} / ${item.target}`}</small>
              </span>
              <span className="fishing-ach-bar" aria-hidden="true">
                <span style={{ width: `${percent}%` }} />
              </span>
            </div>
          )
        })}
      </div>
      <p className="fishing-ach-foot">成就只从本机鱼库推导，清空鱼库会一起清零。</p>
    </section>
  )
})

// ── 主组件 ────────────────────────────────────────────────────────
export default function FishingGame({ onExit }) {
  const session = useAuth()
  const userId = session?.user?.id ?? null

  const [library, setLibrary] = useState(() => loadLibrary(userId))
  const [nickname, setNickname] = useState('')
  const [fish, setFish] = useState([])
  const [aim, setAim] = useState(0)
  const [aiming, setAiming] = useState(false)
  const [net, setNet] = useState({ active: false, d: NET_START, angle: 0, r: 26, x: ORIGIN.x, y: ORIGIN.y })
  const [pending, setPending] = useState(null)
  const [spellLetters, setSpellLetters] = useState([])
  const [spellState, setSpellState] = useState('idle')
  const [toast, setToast] = useState(null)
  const [paused, setPaused] = useState(false)
  const [players, setPlayers] = useState([])
  const [onlineReady, setOnlineReady] = useState(false)
  const [detail, setDetail] = useState(null)
  const [selfView, setSelfView] = useState(null)
  const [viewPlayer, setViewPlayer] = useState(null)
  const [friendDetail, setFriendDetail] = useState(null)
  const [friendProfile, setFriendProfile] = useState(() => loadFriendProfile(userId))
  const [palSnapshot, setPalSnapshot] = useState(() => loadPalSnapshot(userId, friendProfile?.id))
  const [resetArmed, setResetArmed] = useState(false)
  // 每次打开游戏换一个匿名会话 id，只用于在线渔友频道，不落盘。
  const [sessionId] = useState(createSessionId)

  const svgRef = useRef(null)
  const fishRef = useRef([])
  const libraryRef = useRef(library)
  const netRef = useRef(net)
  const aimRef = useRef(0)
  const aimingRef = useRef(false)
  const pausedRef = useRef(false)
  const nextFishIdRef = useRef(0)
  const channelRef = useRef(null)
  const nicknameRef = useRef('')
  const friendProfileRef = useRef(friendProfile)
  const playersRef = useRef([])
  const toastTimerRef = useRef(0)
  const spellTimerRef = useRef(0)
  const mountedRef = useRef(true)

  // 鱼库落盘 / 供 rAF 与拼写判题读取最新值
  useEffect(() => {
    libraryRef.current = library
    saveLibrary(userId, library)
  }, [library, userId])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    supabase
      .from('profiles')
      .select('nickname')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) {
          const name = data?.nickname || '匿名渔夫'
          nicknameRef.current = name
          setNickname(name)
        }
      })
      .catch(() => {
        if (!cancelled) {
          nicknameRef.current = '匿名渔夫'
          setNickname('匿名渔夫')
        }
      })
    return () => { cancelled = true }
  }, [userId])

  // 「鱼友」固定成对方：这个圈子只有两位真人（i4 和姜姜）。
  // 第一次确认后记在本机；如果以后多出第三位真人，也不会硬猜谁是谁。
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    const stored = loadFriendProfile(userId)

    // 鱼友身份确认/变更时，把本机快照对齐到这个鱼友：
    // 对方在线就先抓一份 presence 快照，离线就读取上次留下的快照。
    const rememberFriend = (friend) => {
      friendProfileRef.current = friend
      setFriendProfile(friend)
      if (!friend) {
        setPalSnapshot(null)
        return
      }
      const online = playersRef.current.find(
        (player) => player.name === (friend.nickname || '匿名渔夫'),
      )
      if (!online) {
        setPalSnapshot(loadPalSnapshot(userId, friend.id))
        return
      }
      const snapshot = snapshotFromPresence(friend, online)
      savePalSnapshot(userId, snapshot)
      setPalSnapshot(snapshot)
    }

    supabase
      .from('profiles')
      .select('id,nickname,is_ai,approved')
      .eq('is_ai', false)
      .eq('approved', true)
      .then(({ data, error }) => {
        if (cancelled || error) return
        const profiles = data ?? []
        if (stored) {
          const latest = profiles.find((profile) => profile.id === stored.id)
          const friend = latest
            ? { id: latest.id, nickname: latest.nickname || stored.nickname }
            : stored
          rememberFriend(friend)
          saveFriendProfile(userId, friend)
          return
        }
        const others = profiles.filter((profile) => profile.id !== userId)
        if (others.length === 1) {
          const friend = { id: others[0].id, nickname: others[0].nickname || '渔友' }
          rememberFriend(friend)
          saveFriendProfile(userId, friend)
        } else {
          rememberFriend(null)
        }
      })
      .catch(() => {
        if (!cancelled) rememberFriend(stored)
      })
    return () => { cancelled = true }
  }, [userId])

  const showToast = useCallback((text, tone = 'info') => {
    window.clearTimeout(toastTimerRef.current)
    setToast({ text, tone, id: Date.now() })
    toastTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setToast(null)
    }, 1900)
  }, [])

  useEffect(() => () => {
    window.clearTimeout(toastTimerRef.current)
    window.clearTimeout(spellTimerRef.current)
  }, [])

  const makeFish = useCallback(() => {
    const species = randomSpecies()
    const rarity = RARITIES[species.rarity]
    const direction = Math.random() < 0.5 ? -1 : 1
    const speed = (rarity.speed[0] + Math.random() * (rarity.speed[1] - rarity.speed[0])) * species.speed
    return {
      id: ++nextFishIdRef.current,
      speciesId: species.id,
      x: 110 + Math.random() * 580,
      y: 130 + Math.random() * 390,
      vx: direction * speed,
      vy: (Math.random() - 0.5) * 18,
      hitRadius: 30 * rarity.radius * Math.min(1.9, species.size),
      phase: Math.random() * Math.PI * 2,
    }
  }, [])

  const refillFish = useCallback(() => {
    const next = [...fishRef.current]
    while (next.length < FISH_TARGET) next.push(makeFish())
    fishRef.current = next
    setFish(next)
  }, [makeFish])

  useEffect(() => {
    refillFish()
  }, [refillFish])

  const resumeFishing = useCallback(() => {
    window.clearTimeout(spellTimerRef.current)
    setPending(null)
    setSpellLetters([])
    setSpellState('idle')
    pausedRef.current = false
    setPaused(false)
    refillFish()
  }, [refillFish])

  const grantAuto = useCallback((species) => {
    setLibrary((prev) => withCatch(prev, species, null))
    showToast(`词库已被你捕完，${species.name}直接入账 +${pointsFor(species)}`, 'good')
    window.setTimeout(() => {
      if (!mountedRef.current) return
      pausedRef.current = false
      setPaused(false)
      refillFish()
    }, 650)
  }, [refillFish, showToast])

  const onHooked = useCallback((hookedFish, catchPoint) => {
    const species = FISH_BY_ID[hookedFish.speciesId]
    if (!species) return
    pausedRef.current = true
    setPaused(true)
    netRef.current = { active: false, d: netRef.current.d, angle: netRef.current.angle, r: netRef.current.r, x: catchPoint.x, y: catchPoint.y }
    setNet(netRef.current)

    const word = pickWord(species.rarity, libraryRef.current.usedWords)
    if (!word) {
      grantAuto(species)
      return
    }
    setPending({ species, word })
    setSpellLetters(Array.from({ length: Math.max(1, word.word.length - 2) }, () => ''))
    setSpellState('idle')
    showToast('上钩了，拼出单词就能收进鱼库', 'good')
  }, [grantAuto, showToast])

  // 主循环：鱼游动 + 网飞行 + 撞网判定
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const step = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now

      if (!pausedRef.current) {
        let next = fishRef.current.map((fishItem) => {
          let { x, y, vx, vy } = fishItem
          x += vx * dt
          y += (vy + Math.sin(now / 700 + fishItem.phase) * 8) * dt
          if (x < 68) { x = 68; vx = Math.abs(vx) }
          if (x > VIEW_W - 68) { x = VIEW_W - 68; vx = -Math.abs(vx) }
          if (y < 108) { y = 108; vy = Math.abs(vy) }
          if (y > 548) { y = 548; vy = -Math.abs(vy) }
          return { ...fishItem, x, y, vx, vy }
        })

        const currentNet = netRef.current
        if (currentNet.active) {
          const d = currentNet.d + NET_SPEED * dt
          const x = ORIGIN.x + Math.sin(currentNet.angle) * d
          const y = ORIGIN.y - Math.cos(currentNet.angle) * d
          const radius = 24 + d * 0.032
          const hit = next.find((fishItem) => {
            const dx = fishItem.x - x
            const dy = fishItem.y - y
            return Math.hypot(dx, dy) < fishItem.hitRadius + radius * 0.72
          })

          if (hit) {
            next = next.filter((fishItem) => fishItem.id !== hit.id)
            const catchPoint = { x, y }
            netRef.current = { active: false, d, angle: currentNet.angle, r: radius, x, y }
            setNet(netRef.current)
            fishRef.current = next
            setFish(next)
            onHooked(hit, catchPoint)
            raf = requestAnimationFrame(step)
            return
          }

          if (d > MAX_RANGE) {
            netRef.current = { active: false, d: MAX_RANGE, angle: currentNet.angle, r: 24 + MAX_RANGE * 0.032, x, y }
            setNet(netRef.current)
            showToast('网空了，再等一条鱼经过', 'info')
          } else {
            netRef.current = { active: true, d, angle: currentNet.angle, r: radius, x, y }
            setNet(netRef.current)
          }
        }

        if (next.length < FISH_TARGET && Math.random() < dt * 0.75) next.push(makeFish())
        fishRef.current = next
        setFish(next)
      }

      raf = requestAnimationFrame(step)
    }

    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [makeFish, onHooked, showToast])

  // 瞄准：把屏幕坐标换成 SVG 内坐标，再换算成「从你脚下往上看」的角度
  const pointToScene = (clientX, clientY) => {
    const svg = svgRef.current
    if (!svg) return null
    const point = svg.createSVGPoint()
    point.x = clientX
    point.y = clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    return point.matrixTransform(ctm.inverse())
  }

  const aimAt = useCallback((clientX, clientY) => {
    const point = pointToScene(clientX, clientY)
    if (!point) return
    const dy = point.y - ORIGIN.y
    if (dy > -16) return
    const nextAim = clamp(Math.atan2(point.x - ORIGIN.x, -dy), -AIM_LIMIT, AIM_LIMIT)
    aimRef.current = nextAim
    setAim(nextAim)
  }, [])

  const castNet = useCallback(() => {
    if (pausedRef.current || netRef.current.active) return
    const angle = aimRef.current
    const nextNet = {
      active: true,
      d: NET_START,
      angle,
      r: 24 + NET_START * 0.032,
      x: ORIGIN.x + Math.sin(angle) * NET_START,
      y: ORIGIN.y - Math.cos(angle) * NET_START,
    }
    netRef.current = nextNet
    setNet(nextNet)
  }, [])

  const onPointerDown = (event) => {
    if (pausedRef.current) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    aimingRef.current = true
    setAiming(true)
    aimAt(event.clientX, event.clientY)
  }

  const onPointerMove = (event) => {
    if (pausedRef.current) return
    if (aimingRef.current || event.pointerType === 'mouse') aimAt(event.clientX, event.clientY)
  }

  const onPointerUp = (event) => {
    if (!aimingRef.current) return
    aimingRef.current = false
    setAiming(false)
    if (pausedRef.current) return
    aimAt(event.clientX, event.clientY)
    castNet()
  }

  const onPointerCancel = () => {
    aimingRef.current = false
    setAiming(false)
  }

  const nudgeAim = (delta) => {
    if (pausedRef.current) return
    const next = clamp(aimRef.current + delta, -AIM_LIMIT, AIM_LIMIT)
    aimRef.current = next
    setAim(next)
  }

  useEffect(() => {
    const onKey = (event) => {
      if (pausedRef.current) return
      const tag = event.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        nudgeAim(event.key === 'ArrowLeft' ? -0.09 : 0.09)
      } else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault()
        castNet()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [castNet])

  const changeSpellLetters = useCallback((next) => {
    setSpellLetters(next)
    // 改任意一格就撤掉「还有字母不对」的提示，让玩家安静地重试。
    setSpellState((prev) => (prev === 'wrong' ? 'idle' : prev))
  }, [])

  const submitSpell = (valid) => {
    if (!pending || spellState !== 'idle') return
    const full = pending.word.word
    const expected = full.slice(1, -1).toLowerCase()
    const typed = spellLetters.join('').toLowerCase()
    if (valid && typed === expected) {
      const species = pending.species
      setSpellState('ok')
      setLibrary((prev) => withCatch(prev, species, pending.word.word))
      showToast(`拼写正确，${species.name}入账 +${pointsFor(species)}`, 'good')
      spellTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) resumeFishing()
      }, 1200)
    } else {
      // 不锁死、不放生：红色格子留着，玩家可以一格一格改。
      setSpellState('wrong')
      showToast('还有字母不对，改好再确认', 'bad')
    }
  }

  const closeSpell = useCallback(() => {
    if (spellState !== 'ok') {
      showToast('鱼被放生了', 'info')
    }
    resumeFishing()
  }, [resumeFishing, showToast, spellState])

  const resetLibrary = useCallback(() => {
    const empty = emptyLibrary()
    libraryRef.current = empty
    setLibrary(empty)
    setResetArmed(false)
    setDetail(null)
    setSelfView(null)
    setFriendDetail(null)
    setViewPlayer(null)
    showToast('本机鱼库已清空，重新下海', 'info')
  }, [showToast])

  // Esc 关浮层：拼写面板视为「放生」，鱼种详情 → 渔友鱼库 → 清空确认依次关。
  useEffect(() => {
    const onEscape = (event) => {
      if (event.key !== 'Escape') return
      if (friendDetail) setFriendDetail(null)
      else if (viewPlayer) setViewPlayer(null)
      else if (detail) setDetail(null)
      else if (selfView) setSelfView(null)
      else if (resetArmed) setResetArmed(false)
      else if (pending) closeSpell()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [closeSpell, detail, friendDetail, pending, resetArmed, selfView, viewPlayer])

  // 在线渔友：presence 只在打开游戏时挂上，退出即下线。
  useEffect(() => {
    if (!userId) return
    const channel = supabase.channel(LOBBY_CHANNEL, {
      config: { presence: { key: sessionId } },
    })
    channelRef.current = channel

    const syncPlayers = () => {
      const state = channel.presenceState()
      const bySid = new Map()
      for (const entries of Object.values(state)) {
        for (const raw of entries) {
          const meta = sanitizePresence(raw, sessionId)
          if (!meta) continue
          const previous = bySid.get(meta.sid)
          if (!previous || meta.ts > previous.ts) bySid.set(meta.sid, meta)
        }
      }
      const nextPlayers = [...bySid.values()]
        .sort((a, b) => b.points - a.points)
        .slice(0, MAX_LOBBY)
      playersRef.current = nextPlayers
      setPlayers(nextPlayers)

      // 固定鱼友在线：顺手把这份 presence 快照写到查看者本机；
      // 对方断线时 sync 里没有 TA，保留上一份，正好给离线渲染用。
      const friend = friendProfileRef.current
      if (!friend) return
      const onlineFriend = nextPlayers.find(
        (player) => player.name === (friend.nickname || '匿名渔夫'),
      )
      if (!onlineFriend) return
      const snapshot = snapshotFromPresence(friend, onlineFriend)
      savePalSnapshot(userId, snapshot)
      setPalSnapshot(snapshot)
    }

    channel.on('presence', { event: 'sync' }, syncPlayers)
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setOnlineReady(true)
        channel.track(presenceMeta(sessionId, nicknameRef.current, libraryRef.current)).catch(() => {})
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setOnlineReady(false)
        // 连接断了就不能再拿上一帧 presence 冒充「在线」；固定鱼友会退回本机快照。
        playersRef.current = []
        setPlayers([])
      }
    })

    return () => {
      channelRef.current = null
      setOnlineReady(false)
      setPlayers([])
      supabase.removeChannel(channel)
    }
  }, [sessionId, userId])

  // 鱼库变化后把新战绩同步给渔友（400ms 防抖，避免每捕一条就发一次）
  useEffect(() => {
    if (!onlineReady || !userId) return
    const channel = channelRef.current
    if (!channel) return
    const timer = window.setTimeout(() => {
      channel.track(presenceMeta(sessionId, nickname, library)).catch(() => {})
    }, 400)
    return () => window.clearTimeout(timer)
  }, [library, nickname, onlineReady, sessionId, userId])

  const statistics = useMemo(() => ({
    owned: caughtSpeciesCount(library.caught),
    total: totalFishCount(library.caught),
    words: new Set(library.usedWords).size,
  }), [library])

  const achievementItems = useMemo(() => {
    const metrics = {
      total: statistics.total,
      species: statistics.owned,
      endangered: FISH_BY_RARITY.endangered.filter((fish) => (library.caught[fish.id] ?? 0) > 0).length,
      words: statistics.words,
    }
    return ACHIEVEMENTS.map((achievement) => {
      const value = Math.min(metrics[achievement.metric] ?? 0, achievement.target)
      return { ...achievement, value, done: value >= achievement.target }
    })
  }, [library.caught, statistics])

  const aimEndX = ORIGIN.x + Math.sin(aim) * MAX_RANGE
  const aimEndY = ORIGIN.y - Math.cos(aim) * MAX_RANGE
  const lockedFish = fish.filter((fishItem) => {
    const fishAngle = Math.atan2(fishItem.x - ORIGIN.x, ORIGIN.y - fishItem.y)
    const distance = Math.hypot(fishItem.x - ORIGIN.x, fishItem.y - ORIGIN.y)
    return Math.abs(fishAngle - aim) < 0.055 && distance < MAX_RANGE
  }).map((fishItem) => fishItem.id)

  if (!userId) {
    return (
      <div className="fishing-page">
        <p className="fishing-empty">需要登录后才能下海摸鱼。</p>
      </div>
    )
  }

  const detailWords = detail
    ? (library.caught[detail.id] > 0 ? wordsForFish(library, detail) : { words: [], exact: true })
    : null

  // 「鱼友」固定成另一位真人：在线时把 presence 合进来；离线时用本机保存的
  // 最后一次 presence 快照，并明确标成「上次同步」，不拿旧数据冒充实时。
  const friendOnline = friendProfile
    ? (players.find((player) => player.name === (friendProfile.nickname || '匿名渔夫')) ?? null)
    : null
  const cachedFriend = friendProfile && palSnapshot?.friendId === friendProfile.id
    ? palSnapshot
    : null
  const fixedFriend = friendProfile
    ? {
        sid: friendOnline?.sid ?? `offline-${friendProfile.id}`,
        name: friendProfile.nickname,
        points: friendOnline?.points ?? cachedFriend?.points ?? 0,
        total: friendOnline?.total ?? cachedFriend?.total ?? 0,
        caught: friendOnline?.caught ?? cachedFriend?.caught ?? {},
        wordCount: friendOnline?.wordCount ?? cachedFriend?.wordCount ?? 0,
        words: friendOnline?.words ?? cachedFriend?.words ?? {},
        syncedAt: friendOnline ? 0 : (cachedFriend?.syncedAt ?? 0),
        online: Boolean(friendOnline),
        isFriend: true,
      }
    : null

  // presence 可能比「打开鱼库」晚到：从最新 players 里取同一个 sid，
  // 这样渔友刚同步上来的单词/战绩也能立刻显示，而不是卡在打开那一刻的快照。
  // 固定鱼友则始终跟随 fixedFriend，对方断线时弹层会立刻切到离线快照。
  const activePlayer = viewPlayer
    ? (viewPlayer.isFriend && fixedFriend
        ? fixedFriend
        : (players.find((player) => player.sid === viewPlayer.sid) ?? viewPlayer))
    : null
  const friendWord = friendDetail && activePlayer ? activePlayer.words?.[friendDetail.id] : ''
  const friendCount = friendProfile ? 1 : players.length

  const openFriend = () => {
    if (fixedFriend) {
      setFriendDetail(null)
      setViewPlayer(fixedFriend)
      return
    }
    document.querySelector('.fishing-pals')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div className="fishing-page" data-fishing-game>
      <header className="fishing-top">
        <button type="button" className="fishing-back" onClick={onExit} aria-label="返回实验室">
          <span aria-hidden="true">←</span> 实验室
        </button>
        <div className="fishing-title">
          <p className="fishing-eyebrow">DEEP SEA · SLACK OFF</p>
          <h2>摸鱼</h2>
        </div>
        <div className="fishing-score" aria-label={`当前积分 ${library.points}`}>
          <span>积分</span>
          <strong>{library.points}</strong>
        </div>
      </header>

      <section className="fishing-hud" aria-label="摸鱼战绩">
        <button type="button" className="fishing-hud-item" onClick={() => setSelfView('library')} aria-label="查看我的鱼库">
          <small>鱼库</small>
          <strong>{statistics.owned}<em> / {FISH_SPECIES.length} 种</em></strong>
          <span className="fishing-hud-go" aria-hidden="true">查看 →</span>
        </button>
        <button type="button" className="fishing-hud-item" onClick={() => setSelfView('caught')} aria-label="查看已捕明细">
          <small>已捕</small>
          <strong>{statistics.total}<em> 条</em></strong>
          <span className="fishing-hud-go" aria-hidden="true">查看 →</span>
        </button>
        <button type="button" className="fishing-hud-item" onClick={() => setSelfView('words')} aria-label="查看拼对的单词">
          <small>拼对</small>
          <strong>{statistics.words}<em> 个词</em></strong>
          <span className="fishing-hud-go" aria-hidden="true">查看 →</span>
        </button>
        <button type="button" className="fishing-hud-item" onClick={openFriend} aria-label="查看鱼友">
          <small>鱼友</small>
          <strong>
            {friendCount}
            <em>{friendProfile ? (friendOnline ? ' 在线' : ' 离线') : ' 人'}</em>
          </strong>
          <span className="fishing-hud-go" aria-hidden="true">查看 →</span>
        </button>
      </section>

      <section className="fishing-stage" aria-label="摸鱼海域">
        <svg
          ref={svgRef}
          className={`fishing-water${aiming ? ' is-aiming' : ''}`}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          role="application"
          aria-label="深海渔场。左右拖动瞄准，松手下网；也可以用左右方向键瞄准、空格下网。"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          <defs>
            <linearGradient id="fishing-sea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0a3347" />
              <stop offset="42%" stopColor="#072735" />
              <stop offset="100%" stopColor="#03151e" />
            </linearGradient>
            <radialGradient id="fishing-glow" cx="50%" cy="0%" r="80%">
              <stop offset="0%" stopColor="rgba(143, 240, 255, 0.22)" />
              <stop offset="55%" stopColor="rgba(143, 240, 255, 0.03)" />
              <stop offset="100%" stopColor="rgba(143, 240, 255, 0)" />
            </radialGradient>
            <linearGradient id="fishing-net-stroke" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#a9f5e8" />
              <stop offset="100%" stopColor="#55b3ff" />
            </linearGradient>
            <filter id="fishing-soft-glow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <rect width={VIEW_W} height={VIEW_H} fill="url(#fishing-sea)" />
          <rect width={VIEW_W} height={VIEW_H} fill="url(#fishing-glow)" />

          {/* 水面光柱 */}
          <g className="fishing-rays" aria-hidden="true">
            <path d="M 120 -40 L 250 -40 L 340 620 L 240 620 Z" />
            <path d="M 430 -40 L 520 -40 L 640 620 L 560 620 Z" />
            <path d="M 660 -40 L 710 -40 L 790 620 L 740 620 Z" />
          </g>

          {/* 气泡 */}
          <g className="fishing-bubbles" aria-hidden="true">
            {Array.from({ length: 14 }).map((_, index) => (
              <circle
                key={index}
                cx={70 + ((index * 137) % 660)}
                cy={420 + ((index * 83) % 220)}
                r={2 + (index % 4) * 1.4}
                style={{
                  animationDelay: `${index * 0.7}s`,
                  animationDuration: `${6 + (index % 5)}s`,
                }}
              />
            ))}
          </g>

          {/* 海底剪影 */}
          <g className="fishing-seabed" aria-hidden="true">
            <path d="M 0 610 Q 90 560 170 604 T 340 598 T 520 610 T 700 590 T 800 606 L 800 660 L 0 660 Z" />
            <path d="M 40 620 Q 18 540 58 510 Q 44 566 82 620 Z" />
            <path d="M 88 622 Q 76 552 112 526 Q 94 574 128 622 Z" />
            <path d="M 720 618 Q 700 530 742 500 Q 724 558 766 618 Z" />
            <path d="M 770 620 Q 758 560 790 536 Q 776 578 804 620 Z" />
          </g>

          {/* 鱼群 */}
          {fish.map((fishItem) => {
            const species = FISH_BY_ID[fishItem.speciesId]
            if (!species) return null
            const flip = fishItem.vx < 0 ? -1 : 1
            const tilt = clamp(Math.atan2(fishItem.vy, Math.abs(fishItem.vx)) * 0.55, -0.5, 0.5) * (180 / Math.PI)
            const locked = lockedFish.includes(fishItem.id)
            return (
              <g
                key={fishItem.id}
                className={`fish-swimmer${locked ? ' is-locked' : ''}`}
                transform={`translate(${fishItem.x} ${fishItem.y}) rotate(${tilt * flip}) scale(${flip} 1)`}
              >
                {locked && (
                  <circle
                    r={fishItem.hitRadius * 1.28}
                    className="fish-lock-ring"
                    fill="none"
                    stroke="rgba(169, 245, 232, 0.7)"
                    strokeWidth="2"
                    strokeDasharray="5 7"
                  />
                )}
                <FishShape species={species} />
              </g>
            )
          })}

          {/* 瞄准线 */}
          <g className="fishing-aim-line" aria-hidden="true">
            <line
              x1={ORIGIN.x}
              y1={ORIGIN.y - 12}
              x2={aimEndX}
              y2={aimEndY}
              stroke="rgba(169, 245, 232, 0.45)"
              strokeWidth="1.5"
              strokeDasharray="4 8"
            />
            <circle cx={aimEndX} cy={aimEndY} r="3" fill="rgba(169, 245, 232, 0.8)" />
          </g>

          {/* 渔夫脚下的小船 */}
          <g className="fishing-diver" aria-hidden="true">
            <path d="M 356 630 Q 400 652 444 630 L 432 614 Q 400 624 368 614 Z" fill="#0d3a4a" stroke="rgba(169,245,232,0.28)" strokeWidth="1.5" />
            <path d="M 392 614 L 400 594 L 408 614" fill="none" stroke="rgba(169,245,232,0.5)" strokeWidth="2" strokeLinecap="round" />
            <circle cx="400" cy="590" r="5" fill="#a9f5e8" filter="url(#fishing-soft-glow)" />
          </g>

          {/* 网 */}
          {net.active && (
            <g className="fishing-net" transform={`translate(${net.x} ${net.y})`} aria-hidden="true">
              <circle r={net.r} fill="rgba(85, 179, 255, 0.10)" stroke="url(#fishing-net-stroke)" strokeWidth="2.4" strokeDasharray="6 5" />
              <circle r={net.r * 0.58} fill="none" stroke="rgba(169, 245, 232, 0.55)" strokeWidth="1.2" strokeDasharray="3 5" />
              <path d={`M ${-net.r} 0 H ${net.r} M 0 ${-net.r} V ${net.r}`} stroke="rgba(169, 245, 232, 0.35)" strokeWidth="1" />
            </g>
          )}
        </svg>

        <div className="fishing-stage-note" aria-hidden="true">
          <span className={`fishing-live-dot${onlineReady ? ' is-on' : ''}`} />
          {onlineReady ? `渔友频道在线 · ${players.length} 位渔友` : '渔友频道连接中…'}
        </div>

        <div className={`fishing-toast${toast ? ' is-visible' : ''}${toast?.tone === 'bad' ? ' is-bad' : ''}${toast?.tone === 'good' ? ' is-good' : ''}`} role="status" aria-live="polite">
          {toast?.text ?? ''}
        </div>

      </section>

      <div className="fishing-console">
        <div className="fishing-controls">
          <button type="button" className="fishing-nudge" onClick={() => nudgeAim(-0.11)} aria-label="向左瞄准">←</button>
          <button type="button" className="fishing-cast" onClick={castNet} disabled={paused || net.active}>
            <span>下网</span>
            <kbd>空格</kbd>
          </button>
          <button type="button" className="fishing-nudge" onClick={() => nudgeAim(0.11)} aria-label="向右瞄准">→</button>
        </div>
        <p className="fishing-instruction">按住海面瞄准，松手下网；锁定环亮起的鱼就在网口上。词库取自 CET-4 / CET-6，越稀有的鱼词越长。</p>
      </div>

      <FishingAchievements items={achievementItems} />

      <section className="fishing-pals" aria-label="鱼友">
        <div className="fishing-section-head">
          <h3>鱼友</h3>
          <span>
            {friendProfile
              ? (friendOnline ? '在线' : fixedFriend.syncedAt ? '离线 · 有快照' : onlineReady ? '离线' : '连接中')
              : `${players.length} 人`}
          </span>
        </div>
        {friendProfile ? (
          <div className="fishing-pals-list">
            <button
              type="button"
              className={`fishing-pal${fixedFriend.online ? ' is-online' : ' is-offline'}${fixedFriend.syncedAt ? ' has-snapshot' : ''}`}
              onClick={openFriend}
              aria-label={`查看 ${friendProfile.nickname} 的鱼库${
                fixedFriend.online
                  ? `，${fixedFriend.points} 分，拼对 ${fixedFriend.wordCount} 个词`
                  : fixedFriend.syncedAt
                    ? `，上次同步于 ${formatSyncTime(fixedFriend.syncedAt)}`
                    : '，对方当前离线'
              }`}
            >
              <span className="fishing-pal-avatar" aria-hidden="true">{friendProfile.nickname.slice(0, 1)}</span>
              <span className="fishing-pal-copy">
                <strong>{friendProfile.nickname}</strong>
                <small>
                  {fixedFriend.online
                    ? `${fixedFriend.points} 分 · ${caughtSpeciesCount(fixedFriend.caught)} 种 · 拼对 ${fixedFriend.wordCount} 个词`
                    : fixedFriend.syncedAt
                      ? `上次同步 ${formatSyncTime(fixedFriend.syncedAt)} · ${fixedFriend.points} 分 · ${caughtSpeciesCount(fixedFriend.caught)} 种 · 拼对 ${fixedFriend.wordCount} 个词`
                      : '还没打开摸鱼；打开后就能看到 TA 的鱼库'}
                </small>
              </span>
              <span className="fishing-pal-go" aria-hidden="true">
                {fixedFriend.online || fixedFriend.syncedAt ? '看鱼库 →' : '等 TA 上线 →'}
              </span>
            </button>
          </div>
        ) : players.length > 0 ? (
          <div className="fishing-pals-list">
            {players.map((player) => (
              <button
                type="button"
                className="fishing-pal is-online"
                key={player.sid}
                onClick={() => {
                  setFriendDetail(null)
                  setViewPlayer({ ...player, online: true })
                }}
                aria-label={`查看 ${player.name} 的鱼库，${player.points ?? 0} 分，拼对 ${player.wordCount ?? 0} 个词`}
              >
                <span className="fishing-pal-avatar" aria-hidden="true">{player.name.slice(0, 1)}</span>
                <span className="fishing-pal-copy">
                  <strong>{player.name}</strong>
                  <small>{player.points ?? 0} 分 · {caughtSpeciesCount(player.caught)} 种 · 拼对 {player.wordCount ?? 0} 个词</small>
                </span>
                <span className="fishing-pal-go" aria-hidden="true">看鱼库 →</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="fishing-pals-empty">
            {onlineReady
              ? '还没有别的渔夫上线。等他们打开摸鱼，就能互相看到鱼库。'
              : '正在连渔友频道；连上后，所有打开摸鱼的人都能互相看鱼库。'}
          </p>
        )}
      </section>

      <FishingLibrary library={library} onDetail={setDetail} />

      <p className="fishing-foot">
        鱼库按账号存在本机；拼对过的四/六级词不会再出现。鱼友只共享游戏战绩和拼对单词数，不共享任何私密内容。
      </p>

      <div className={`fishing-reset${resetArmed ? ' is-armed' : ''}`}>
        {resetArmed ? (
          <>
            <p role="alert">清空后积分、鱼库和拼过的词都会消失，且不能撤销。</p>
            <div className="fishing-reset-actions">
              <button type="button" className="fishing-btn is-ghost" onClick={() => setResetArmed(false)}>取消</button>
              <button type="button" className="fishing-btn is-danger" onClick={resetLibrary}>确认清空</button>
            </div>
          </>
        ) : (
          <button type="button" className="fishing-reset-link" onClick={() => setResetArmed(true)}>
            清空本机鱼库
          </button>
        )}
      </div>

      {selfView === 'library' && (
        <LibraryDialog
          library={library}
          onClose={() => setSelfView(null)}
          onDetail={(species) => {
            setSelfView(null)
            setDetail(species)
          }}
        />
      )}
      {selfView === 'caught' && (
        <CaughtDialog
          library={library}
          onClose={() => setSelfView(null)}
          onDetail={(species) => {
            setSelfView(null)
            setDetail(species)
          }}
        />
      )}
      {selfView === 'words' && (
        <WordsDialog library={library} onClose={() => setSelfView(null)} />
      )}
      {pending && (
        <SpellPanel
          pending={pending}
          letters={spellLetters}
          onChange={changeSpellLetters}
          state={spellState}
          onSubmit={submitSpell}
          onGiveUp={closeSpell}
          onClose={resumeFishing}
        />
      )}
      {detail && (
        <FishDetail
          species={detail}
          count={library.caught[detail.id] ?? 0}
          words={detailWords?.words ?? []}
          wordsLabel={detailWords?.exact ? '你拼出过的单词' : '这一档拼出过的单词'}
          emptyNote={
            library.caught[detail.id] > 0
              ? '这条鱼是旧版本捕到的，当时还没有记下鱼种对应的单词；之后再捕到同种鱼就会补上。'
              : '还没捕到。拼出这种鱼的单词后，会记在这里。'
          }
          onClose={() => setDetail(null)}
        />
      )}
      {activePlayer && (
        <PlayerLibrary
          player={activePlayer}
          onDetail={setFriendDetail}
          onClose={() => {
            setFriendDetail(null)
            setViewPlayer(null)
          }}
        />
      )}
      {friendDetail && activePlayer && (
        <FishDetail
          species={friendDetail}
          count={activePlayer.caught?.[friendDetail.id] ?? 0}
          words={friendWord ? [friendWord] : []}
          wordsLabel="最近拼出的单词"
          emptyNote="渔友只共享每个鱼种最近拼出的一个词；没显示就说明还没有拼到这种鱼，或者对方用的是旧版本。"
          onClose={() => setFriendDetail(null)}
        />
      )}
    </div>
  )
}
