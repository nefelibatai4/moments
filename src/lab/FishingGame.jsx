import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import FishShape from './FishShape'
import {
  ACHIEVEMENTS,
  FISH_BY_ID,
  FISH_BY_RARITY,
  FISH_SPECIES,
  RARITIES,
  RARITY_ORDER,
  pickWord,
  randomSpecies,
} from './fishingData'

// ── 「摸鱼」────────────────────────────────────────────────────────
// 玩法：拖动海面瞄准，松手把网撒出去；网口碰到鱼就咬钩，接着拼一个
// 六级单词（首尾字母给出）才算入账。拼错鱼会跑掉，拼对过的词不再出现。
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
  return { v: 1, points: 0, total: 0, caught: {}, usedWords: [] }
}

function loadLibrary(userId) {
  if (!userId) return emptyLibrary()
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${userId}`)
    if (!raw) return emptyLibrary()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return emptyLibrary()
    return {
      v: 1,
      points: sanitizeCount(parsed.points),
      total: sanitizeCount(parsed.total),
      caught: sanitizeCaught(parsed.caught),
      usedWords: Array.isArray(parsed.usedWords)
        ? parsed.usedWords.filter((w) => typeof w === 'string' && /^[a-z]+$/i.test(w)).slice(0, 500)
        : [],
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
  return {
    ...library,
    points: library.points + points,
    total: library.total + 1,
    caught: { ...library.caught, [species.id]: (library.caught[species.id] ?? 0) + 1 },
    usedWords: word ? [...library.usedWords, word] : library.usedWords,
  }
}

// 把当前鱼库压缩成 presence 元数据：只带昵称/战绩，不带账号 id。
function presenceMeta(sessionId, nickname, library) {
  return {
    sid: sessionId,
    name: (nickname || '匿名渔夫').slice(0, 20),
    points: sanitizeCount(library.points),
    total: sanitizeCount(library.total),
    caught: sanitizeCaught(library.caught),
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
function SpellPanel({ pending, value, onChange, state, onSubmit, onGiveUp, onClose }) {
  const full = pending.word.word
  const middle = full.slice(1, -1)
  const meta = RARITIES[pending.species.rarity]
  const points = pointsFor(pending.species)
  const done = state !== 'idle'

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

        <form onSubmit={onSubmit}>
          <div
            className={`fishing-spell-word${state === 'wrong' ? ' is-wrong' : ''}${state === 'ok' ? ' is-ok' : ''}`}
            aria-live="polite"
          >
            <span className="fishing-letter is-fixed" aria-hidden="true">{full[0]}</span>
            <input
              className="fishing-spell-input"
              value={value}
              onChange={(event) => onChange(event.target.value.replace(/[^a-zA-Z]/g, ''))}
              maxLength={middle.length}
              autoFocus
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              aria-label={`拼出 ${pending.species.name} 对应的单词，首字母 ${full[0]}，尾字母 ${full.at(-1)}，中间 ${middle.length} 个字母`}
              style={{ width: `calc(${Math.max(2, middle.length)}ch + 1.2em)` }}
              disabled={done}
            />
            <span className="fishing-letter is-fixed" aria-hidden="true">{full.at(-1)}</span>
          </div>

          <p className="fishing-spell-meta">
            六级词 · 共 {full.length} 个字母 · 首尾已给出 · 拼对 +{points} 分
          </p>

          {state === 'wrong' && (
            <p className="fishing-spell-result is-bad">拼错了，鱼被放生。正确拼写：<strong>{full}</strong></p>
          )}
          {state === 'ok' && (
            <p className="fishing-spell-result is-good">拼写正确，{pending.species.name}已收进鱼库，+{points} 分</p>
          )}

          <div className="fishing-spell-actions">
            {!done ? (
              <>
                <button type="button" className="fishing-btn is-ghost" onClick={onGiveUp}>放生</button>
                <button type="submit" className="fishing-btn is-primary" disabled={!value.trim()}>确认拼写</button>
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
function FishDetail({ species, count, onClose }) {
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
      </div>
    </div>
  )
}

// ── 渔友鱼库 ──────────────────────────────────────────────────────
function PlayerLibrary({ player, onClose }) {
  const library = {
    points: player.points,
    total: player.total,
    caught: player.caught ?? {},
    usedWords: [],
  }
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
            <p className="fishing-eyebrow">在线渔友</p>
            <h3 id="fishing-player-title">{player.name}</h3>
            <p>{player.points ?? 0} 分 · 已捕 {player.total ?? 0} 条</p>
          </div>
        </div>
        <FishingLibrary library={library} ownerLabel={`${player.name} 的鱼库`} />
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
  const [spellInput, setSpellInput] = useState('')
  const [spellState, setSpellState] = useState('idle')
  const [toast, setToast] = useState(null)
  const [paused, setPaused] = useState(false)
  const [players, setPlayers] = useState([])
  const [onlineReady, setOnlineReady] = useState(false)
  const [detail, setDetail] = useState(null)
  const [viewPlayer, setViewPlayer] = useState(null)
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
    setSpellInput('')
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
    setSpellInput('')
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

  const submitSpell = (event) => {
    event.preventDefault()
    if (!pending || spellState !== 'idle') return
    const full = pending.word.word
    const expected = full.slice(1, -1).toLowerCase()
    const typed = spellInput.trim().toLowerCase()
    if (typed === expected) {
      const species = pending.species
      setSpellState('ok')
      setLibrary((prev) => withCatch(prev, species, pending.word.word))
      showToast(`拼写正确，${species.name}入账 +${pointsFor(species)}`, 'good')
      spellTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) resumeFishing()
      }, 1200)
    } else {
      // 拼错后不自动关：把正确拼写留在屏幕上，让玩家自己看完再继续。
      setSpellState('wrong')
      showToast('拼错了，鱼被放生', 'bad')
    }
  }

  const closeSpell = useCallback(() => {
    if (spellState === 'idle') {
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
    setViewPlayer(null)
    showToast('本机鱼库已清空，重新下海', 'info')
  }, [showToast])

  // Esc 关浮层：拼写面板视为「放生」，详情/渔友鱼库直接关。
  useEffect(() => {
    const onEscape = (event) => {
      if (event.key !== 'Escape') return
      if (viewPlayer) setViewPlayer(null)
      else if (detail) setDetail(null)
      else if (resetArmed) setResetArmed(false)
      else if (pending) closeSpell()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [closeSpell, detail, pending, resetArmed, viewPlayer])

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
      setPlayers(
        [...bySid.values()]
          .sort((a, b) => b.points - a.points)
          .slice(0, MAX_LOBBY),
      )
    }

    channel.on('presence', { event: 'sync' }, syncPlayers)
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setOnlineReady(true)
        channel.track(presenceMeta(sessionId, nicknameRef.current, libraryRef.current)).catch(() => {})
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setOnlineReady(false)
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
    words: library.usedWords.length,
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
        <div><small>鱼库</small><strong>{statistics.owned}<em> / {FISH_SPECIES.length} 种</em></strong></div>
        <div><small>已捕</small><strong>{statistics.total}<em> 条</em></strong></div>
        <div><small>拼对</small><strong>{statistics.words}<em> 个词</em></strong></div>
        <div><small>在线渔友</small><strong>{onlineReady ? players.length : '—'}<em> 人</em></strong></div>
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
        <p className="fishing-instruction">按住海面瞄准，松手下网；锁定环亮起的鱼就在网口上。词库是六级英语，越稀有的鱼词越长。</p>
      </div>

      <FishingAchievements items={achievementItems} />

      <section className="fishing-pals" aria-label="在线渔友">
        <div className="fishing-section-head">
          <h3>在线渔友</h3>
          <span>{onlineReady ? `${players.length} 人` : '连接中'}</span>
        </div>
        {players.length > 0 ? (
          <div className="fishing-pals-list">
            {players.map((player) => (
              <button
                type="button"
                className="fishing-pal"
                key={player.sid}
                onClick={() => setViewPlayer(player)}
                aria-label={`查看 ${player.name} 的鱼库，${player.points ?? 0} 分`}
              >
                <span className="fishing-pal-avatar" aria-hidden="true">{player.name.slice(0, 1)}</span>
                <span className="fishing-pal-copy">
                  <strong>{player.name}</strong>
                  <small>{player.points ?? 0} 分 · {caughtSpeciesCount(player.caught)} 种 · {player.total ?? 0} 条</small>
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
        鱼库按账号存在本机；拼对过的六级词不会再出现。在线渔友只共享游戏战绩，不共享任何私密内容。
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

      {pending && (
        <SpellPanel
          pending={pending}
          value={spellInput}
          onChange={setSpellInput}
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
          onClose={() => setDetail(null)}
        />
      )}
      {viewPlayer && <PlayerLibrary player={viewPlayer} onClose={() => setViewPlayer(null)} />}
    </div>
  )
}
