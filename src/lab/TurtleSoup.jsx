import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { useImeGuard } from '../lib/ime'
import {
  TURTLE_BY_ID,
  TURTLE_DIFFICULTY,
  TURTLE_SOUPS,
  markTurtlePlayed,
  normalizeTurtlePlayed,
  pickTurtle,
  turtleQuestionAwards,
} from './turtleData'

// ── 「海龟汤」多人游戏（真 Ace 主持）────────────────────────────────
// 玩法：Ace 是唯一的出题人、回答者和判定者，所有用户都只当玩家：
//   · 任何玩家都可以请 Ace 出题（大厅/结案后），并按入门/进阶/烧脑随机抽题；
//   · 提问和猜底通过公共频道发给外部常驻的 Ace 主持端
//     （scripts/ace-turtle-host.mjs），由它取该题汤底问 DeepSeek；
//   · 主持端广播判定词和一句 12-30 字、不泄底的短回复（ace-verdict.reply），
//     浏览器不本地判定、不猜答案；
//   · 发出请求后等事件；5 秒没有判定就提示「Ace 不在线」，不会自己补答。
//   · 短回复缺失或不合格时，回退到固定的判定模板；模型文本不直接进页面。
//
// 同步边界（实验室规矩）：
//   · 不建表、不写库：房间状态通过 Supabase Realtime 公共频道 broadcast
//     下发；在线玩家用 presence 互通。
//   · 不广播账号 id：频道里用一次性会话 id（sid）和一个本机随机玩家 id（pid）。
//   · 汤底只出现在结案卡片里；播放中不渲染给任何玩家。
//     汤底本身随前端包下发，所以这是界面约束，不是安全边界；真正用于判定的
//     汤底在外部 Ace 进程里读取，判定广播只带判定词和一句 12-30 字的引导。
//   · 公共频道里任何拿到 anon key 的人都能订阅，发送的提问/猜测不应包含隐私。
//
// 房间状态仍由 presence 中最早进入的浏览器汇总（界面不暴露这个角色），
// 它只负责把提问/猜底排进队列、接收 ace-verdict、广播整包状态；
// 判定权在频道外的 Ace 主持端。公共频道无法验证发送者身份，收到的内容都会先清洗。
const DEFAULT_CHANNEL = 'moments-turtle-soup-v1'

// 只在本机 dev 验收里用 ?turtleChannel=... 隔离测试频道，生产包不会读 URL。
function resolveChannelName() {
  try {
    if (import.meta.env.DEV) {
      const override = new URLSearchParams(window.location.search).get('turtleChannel')
      if (override && /^[a-zA-Z0-9:_-]{1,96}$/.test(override)) return override
    }
  } catch {
    /* 非浏览器环境或旧浏览器：用公共频道 */
  }
  return DEFAULT_CHANNEL
}

const CHANNEL_NAME = resolveChannelName()
const SCORE_PREFIX = 'moments-turtle-soup-score-v1:'
const PLAYER_PREFIX = 'moments-turtle-soup-player-v1:'
const COUNT_CAP = 999999
const MAX_NAME = 20
const MAX_QUESTION_TEXT = 140
const MAX_GUESS_TEXT = 180
const MAX_ACE_REPLY = 30
const MAX_QUESTIONS = 60
const MAX_GUESSES = 40
const MAX_PLAYERS = 24
const MAX_SEEN = 240
const QUESTION_COOLDOWN = 800
const ACE_WAIT_MS = 5000

const VERDICTS = [
  { id: 'yes', label: '是', hint: '符合汤底' },
  { id: 'no', label: '否', hint: '与汤底相反' },
  { id: 'irrelevant', label: '无关', hint: '和真相没关系' },
  { id: 'partial', label: '部分', hint: '对了一部分' },
]
const VERDICT_BY_ID = Object.fromEntries(VERDICTS.map((item) => [item.id, item]))
const STATUS_LABEL = { lobby: '候场', playing: '推理中', ended: '已结案' }

// 短评只由判定词推导，固定模板、不碰汤底：模型返回再长也进不了页面。
// 模板也按 Ace 的人设写：像朋友接话、12-30 字，不用系统播报腔。
const QUESTION_NOTE = {
  yes: '嗯，这条能走，顺着它再往下问一层。',
  no: '不是这样，但别急着否掉整条思路。',
  irrelevant: '这条问偏了，故事里没这一层，回来抓主线。',
  partial: '沾到边了，但还差一层，把那半句补全。',
}
const GUESS_NOTE = {
  correct: '就是这条线，收网吧，剩下的串起来。',
  wrong: '还差关键一环，先别收，再补一层。',
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function randomToken() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  } catch {
    /* 老浏览器没有 randomUUID，走下面的兜底 */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function createSessionId() {
  return `sid-${randomToken()}`
}

function startTimestamp() {
  return Date.now()
}

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function cleanId(value) {
  const text = String(value ?? '').trim()
  if (!text || text.length > 96) return ''
  return /^[a-zA-Z0-9:_-]+$/.test(text) ? text : ''
}

// 主持端已经做过泄底/长度检查；前端仍按不可信输入收口，最多 30 个字。
function cleanReply(value) {
  const text = cleanText(value, MAX_ACE_REPLY * 4)
  return Array.from(text).slice(0, MAX_ACE_REPLY).join('').trim()
}

function safeTime(value, fallback = 0) {
  const time = Math.floor(Number(value))
  if (!Number.isFinite(time) || time <= 0) return fallback
  return time
}

function sanitizeCount(value, cap = COUNT_CAP) {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.min(number, cap)
}

function sanitizeScore(value) {
  return sanitizeCount(value, COUNT_CAP)
}

function formatClock(value) {
  const time = safeTime(value)
  if (!time) return ''
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// ── 本机记分 / 玩家 id ─────────────────────────────────────────────
function emptyStats() {
  return { v: 2, score: 0, wins: 0, questions: 0, seen: [] }
}

function loadStats(userId) {
  if (!userId) return emptyStats()
  try {
    const raw = localStorage.getItem(`${SCORE_PREFIX}${userId}`)
    if (!raw) return emptyStats()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return emptyStats()
    const seen = Array.isArray(parsed.seen)
      ? parsed.seen
        .filter((key) => typeof key === 'string' && key.length > 0 && key.length <= 120)
        .slice(-MAX_SEEN)
      : []
    return {
      v: 2,
      score: sanitizeScore(parsed.score),
      wins: sanitizeCount(parsed.wins, 9999),
      questions: sanitizeCount(parsed.questions, 99999),
      seen,
    }
  } catch {
    return emptyStats()
  }
}

function saveStats(userId, stats) {
  if (!userId) return
  try {
    localStorage.setItem(`${SCORE_PREFIX}${userId}`, JSON.stringify(stats))
  } catch {
    /* 隐私模式 / 配额满：本局照常，只是积分不落盘 */
  }
}

function loadOrCreatePlayerId(userId) {
  if (!userId) return ''
  try {
    const stored = localStorage.getItem(`${PLAYER_PREFIX}${userId}`)
    if (stored && /^pid-[a-zA-Z0-9-]{6,90}$/.test(stored)) return stored
    const next = `pid-${randomToken()}`
    localStorage.setItem(`${PLAYER_PREFIX}${userId}`, next)
    return next
  } catch {
    return `pid-${randomToken()}`
  }
}

// ── 房间状态 ──────────────────────────────────────────────────────
function emptyRoom(hostSid, hostPid) {
  return {
    v: 1,
    hostSid,
    hostPid,
    puzzleId: '',
    status: 'lobby',
    roundId: '',
    startedAt: 0,
    endedAt: 0,
    endReason: null,
    winnerSid: '',
    winnerPid: '',
    winnerName: '',
    winningGuess: '',
    questions: [],
    guesses: [],
    played: [],
    revision: 0,
    updatedAt: Date.now(),
  }
}

function sanitizeQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = cleanId(raw.id)
  const sid = cleanId(raw.sid)
  const text = cleanText(raw.text, MAX_QUESTION_TEXT)
  if (!id || !sid || !text) return null
  return {
    id,
    sid,
    pid: cleanId(raw.pid),
    name: cleanText(raw.name, MAX_NAME) || '匿名侦探',
    text,
    at: safeTime(raw.at, Date.now()),
    verdict: Object.prototype.hasOwnProperty.call(VERDICT_BY_ID, raw.verdict) ? raw.verdict : '',
    reply: cleanReply(raw.reply),
    answeredAt: safeTime(raw.answeredAt),
  }
}

function sanitizeGuess(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = cleanId(raw.id)
  const sid = cleanId(raw.sid)
  const text = cleanText(raw.text, MAX_GUESS_TEXT)
  if (!id || !sid || !text) return null
  const verdict = ['pending', 'wrong', 'correct'].includes(raw.verdict) ? raw.verdict : 'pending'
  return {
    id,
    sid,
    pid: cleanId(raw.pid),
    name: cleanText(raw.name, MAX_NAME) || '匿名侦探',
    text,
    at: safeTime(raw.at, Date.now()),
    verdict,
    reply: cleanReply(raw.reply),
    judgedAt: safeTime(raw.judgedAt),
  }
}

function sanitizeAceRequest(raw) {
  if (!raw || typeof raw !== 'object') return null
  const sid = cleanId(raw.sid)
  const action = raw.action === 'reveal' ? 'reveal' : raw.action === 'start' ? 'start' : ''
  if (!sid || !action) return null
  return {
    id: cleanId(raw.id),
    sid,
    pid: cleanId(raw.pid),
    action,
    puzzleId: Object.prototype.hasOwnProperty.call(TURTLE_BY_ID, raw.puzzleId) ? raw.puzzleId : '',
    difficulty: Object.prototype.hasOwnProperty.call(TURTLE_DIFFICULTY, raw.difficulty)
      ? raw.difficulty
      : '',
    at: safeTime(raw.at, Date.now()),
  }
}

// 外部 Ace 会发判定词和一句短回复；这里仍然按类型白名单收口，避免伪造事件
// 把任意文本带进问答记录。roundId 用来丢掉上一局的迟到判定。
function sanitizeAceVerdict(raw) {
  if (!raw || typeof raw !== 'object') return null
  const requestId = cleanId(raw.requestId)
  const kind = raw.kind === 'guess' ? 'guess' : raw.kind === 'question' ? 'question' : ''
  const puzzleId = Object.prototype.hasOwnProperty.call(TURTLE_BY_ID, raw.puzzleId)
    ? raw.puzzleId
    : ''
  const roundId = cleanId(raw.roundId)
  let verdict = ''
  if (kind === 'question') {
    verdict = Object.prototype.hasOwnProperty.call(VERDICT_BY_ID, raw.verdict) ? raw.verdict : ''
  } else if (kind === 'guess') {
    verdict = raw.verdict === 'correct' || raw.verdict === 'wrong' ? raw.verdict : ''
  }
  if (!requestId || !kind || !puzzleId || !roundId || !verdict) return null
  return {
    requestId,
    kind,
    puzzleId,
    roundId,
    verdict,
    reply: cleanReply(raw.reply),
    at: safeTime(raw.at, Date.now()),
  }
}

// 公共频道里的状态可能是任何人伪造的：一律重新收口，宁可丢一局也不让
// 异常数据把页面撑爆或渲染出奇怪的东西。
function sanitizeRoom(raw, from) {
  if (!raw || typeof raw !== 'object') return null
  const hostSid = cleanId(raw.hostSid) || cleanId(from)
  if (!hostSid) return null
  const puzzleId = Object.prototype.hasOwnProperty.call(TURTLE_BY_ID, raw.puzzleId)
    ? raw.puzzleId
    : ''
  let status = ['lobby', 'playing', 'ended'].includes(raw.status) ? raw.status : 'lobby'
  if (!puzzleId) status = 'lobby'
  const roundId = cleanId(raw.roundId)
  if (status !== 'lobby' && !roundId) return null

  const questionIds = new Set()
  const questions = []
  if (Array.isArray(raw.questions)) {
    for (const item of raw.questions) {
      const question = sanitizeQuestion(item)
      if (!question || questionIds.has(question.id)) continue
      questionIds.add(question.id)
      questions.push(question)
      if (questions.length >= MAX_QUESTIONS) break
    }
  }

  const guessIds = new Set()
  const guesses = []
  if (Array.isArray(raw.guesses)) {
    for (const item of raw.guesses) {
      const guess = sanitizeGuess(item)
      if (!guess || guessIds.has(guess.id)) continue
      guessIds.add(guess.id)
      guesses.push(guess)
      if (guesses.length >= MAX_GUESSES) break
    }
  }

  const ended = status === 'ended'
  const played = normalizeTurtlePlayed(raw.played)
  // 当前局一定算已玩：兼容还没发 played 的旧版汇总端。
  if (status !== 'lobby' && puzzleId && !played.includes(puzzleId)) played.push(puzzleId)
  return {
    v: 1,
    hostSid,
    hostPid: cleanId(raw.hostPid),
    puzzleId,
    status,
    roundId,
    startedAt: safeTime(raw.startedAt),
    endedAt: ended ? safeTime(raw.endedAt) : 0,
    endReason: ended ? (raw.endReason === 'guessed' ? 'guessed' : 'revealed') : null,
    winnerSid: ended ? cleanId(raw.winnerSid) : '',
    winnerPid: ended ? cleanId(raw.winnerPid) : '',
    winnerName: ended ? cleanText(raw.winnerName, MAX_NAME) : '',
    winningGuess: ended ? cleanText(raw.winningGuess, MAX_GUESS_TEXT) : '',
    questions,
    guesses,
    played,
    revision: Math.max(0, Math.floor(Number(raw.revision) || 0)),
    updatedAt: safeTime(raw.updatedAt, Date.now()),
  }
}

function sanitizePlayer(raw) {
  if (!raw || typeof raw !== 'object') return null
  const sid = cleanId(raw.sid)
  if (!sid) return null
  return {
    sid,
    pid: cleanId(raw.pid),
    name: cleanText(raw.name, MAX_NAME) || '匿名侦探',
    joinedAt: safeTime(raw.joinedAt, Date.now()),
    score: sanitizeScore(raw.score),
    ts: safeTime(raw.ts),
  }
}

function hostOrder(a, b) {
  return a.joinedAt - b.joinedAt || a.sid.localeCompare(b.sid)
}

// ── 小元件 ────────────────────────────────────────────────────────
function VerdictChip({ verdict }) {
  const meta = VERDICT_BY_ID[verdict]
  if (!meta) return null
  return (
    <span className={`turtle-verdict is-${verdict}`} data-turtle-verdict-chip={verdict}>
      {meta.label}
    </span>
  )
}

function PuzzlePicker({ currentId, played = [], onPick, compact = false }) {
  const playedSet = new Set(played)
  const playedCount = TURTLE_SOUPS.filter((soup) => playedSet.has(soup.id)).length
  return (
    <details className={`turtle-archive${compact ? ' is-compact' : ''}`}>
      <summary>
        从十份档案里挑一题
        {playedCount > 0 ? ` · 已玩 ${playedCount}/${TURTLE_SOUPS.length}` : ''}
      </summary>
      <div className="turtle-archive-grid">
        {TURTLE_SOUPS.map((soup, index) => {
          const difficulty = TURTLE_DIFFICULTY[soup.difficulty]
          const isPlayed = playedSet.has(soup.id)
          const isCurrent = soup.id === currentId
          return (
            <button
              key={soup.id}
              type="button"
              className={`turtle-archive-card${isCurrent ? ' is-current' : ''}${isPlayed ? ' is-played' : ''}`}
              onClick={() => onPick(soup.id)}
              aria-current={isCurrent ? 'true' : undefined}
              aria-label={`${soup.title}${isCurrent ? '（本局）' : isPlayed ? '（已玩）' : ''}`}
              data-turtle-pick={soup.id}
              data-turtle-played={isPlayed ? 'true' : 'false'}
            >
              <span className="turtle-archive-no">{String(index + 1).padStart(2, '0')}</span>
              <span className="turtle-archive-title">{soup.title}</span>
              <span className="turtle-archive-sub">
                <span className="turtle-archive-diff" style={{ '--turtle-diff': difficulty?.color }}>
                  {difficulty?.label ?? '档案'}
                </span>
                {isPlayed && (
                  <span className="turtle-archive-played">{isCurrent ? '本局' : '已玩'}</span>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </details>
  )
}

// 大厅和结案后共用：选难度只改本机状态，真正抽题在「请 Ace 出题」时发请求。
function DifficultyPicker({ value, onSelect }) {
  return (
    <div className="turtle-difficulty" role="group" aria-label="选择难度" data-turtle-difficulty-picker>
      <span className="turtle-difficulty-label">选择难度</span>
      <div className="turtle-difficulty-options">
        {Object.values(TURTLE_DIFFICULTY).map((level) => {
          const selected = value === level.id
          return (
            <button
              key={level.id}
              type="button"
              className={`turtle-difficulty-btn${selected ? ' is-selected' : ''}`}
              style={{ '--turtle-diff': level.color }}
              aria-pressed={selected}
              onClick={() => onSelect(level.id)}
              data-turtle-difficulty={level.id}
              data-turtle-points={level.points}
            >
              <strong>{level.label}</strong>
              <small>猜中 +{level.points}</small>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── 主组件 ────────────────────────────────────────────────────────
export default function TurtleSoup({ onExit }) {
  const session = useAuth()
  const userId = session?.user?.id ?? null

  const [sessionId] = useState(createSessionId)
  const [joinedAt] = useState(startTimestamp)
  const [playerId] = useState(() => loadOrCreatePlayerId(userId))
  const [nickname, setNickname] = useState('')
  const nicknameRef = useRef('')

  // 路由由 RequireAuth 守着，挂载时 userId 已经就绪；积分按账号分 key 存本机。
  const [stats, setStats] = useState(() => loadStats(userId))
  const statsRef = useRef(stats)
  const [selectedDifficulty, setSelectedDifficulty] = useState('easy')

  const [room, setRoom] = useState(null)
  const roomRef = useRef(null)
  const [players, setPlayers] = useState([])
  const playersRef = useRef([])
  const [onlineReady, setOnlineReady] = useState(false)
  const [channelStatus, setChannelStatus] = useState('connecting')

  const [questionDraft, setQuestionDraft] = useState('')
  const [guessDraft, setGuessDraft] = useState('')
  const [toast, setToast] = useState(null)
  const [aceNow, setAceNow] = useState(() => Date.now())

  const channelRef = useRef(null)
  const presenceTimerRef = useRef(0)
  const helloTimerRef = useRef(0)
  const toastTimerRef = useRef(0)
  const lastQuestionAtRef = useRef(0)
  // ace-verdict 可能比房间快照先到（本地 mock 时尤其明显）：短暂重试，
  // 等提问/猜底进入房间后再写判定，避免整条答复被丢掉。
  const aceRetryTimersRef = useRef(new Set())
  const imeGuard = useImeGuard()

  const applyRoom = useCallback((next) => {
    roomRef.current = next
    setRoom(next)
  }, [])

  // 5 秒没等到外部 Ace 的判定就停表提示；只影响展示，不改房间状态，
  // 所以迟到的 ace-verdict 仍然能被接收并以真实判定覆盖「不在线」。
  const hasLiveAceWait = useMemo(() => {
    if (!room) return false
    return room.questions.some((question) => (
      !question.verdict && aceNow - (question.at || 0) < ACE_WAIT_MS
    )) || room.guesses.some((guess) => (
      guess.verdict === 'pending' && aceNow - (guess.at || 0) < ACE_WAIT_MS
    ))
  }, [room, aceNow])

  useEffect(() => {
    if (!hasLiveAceWait) return undefined
    // 只心跳刷新展示时间；真正的判定仍然只来自 ace-verdict。
    const timer = window.setInterval(() => setAceNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [hasLiveAceWait])

  const isQuestionTimedOut = (question) => Boolean(
    question
    && !question.verdict
    && aceNow - (question.at || 0) >= ACE_WAIT_MS,
  )
  const isGuessTimedOut = (guess) => Boolean(
    guess
    && guess.verdict === 'pending'
    && aceNow - (guess.at || 0) >= ACE_WAIT_MS,
  )

  const sendBroadcast = useCallback((event, payload) => {
    const channel = channelRef.current
    if (!channel) return false
    try {
      Promise.resolve(channel.send({
        type: 'broadcast',
        event,
        payload,
      })).catch(() => {})
      return true
    } catch {
      return false
    }
  }, [])

  const broadcastState = useCallback((state) => {
    if (!state) return
    sendBroadcast('state', { from: sessionId, state })
  }, [sendBroadcast, sessionId])

  // 主持端每次改房间都整包广播：汤面、问答、判定、猜测和结案状态一次到位。
  // 公共频道不保证送达，所以主持端在 presence 变化时还会补发一次当前快照。
  const commitRoom = useCallback((next) => {
    if (!next) return null
    const current = roomRef.current
    const revision = Math.max(Number(current?.revision) || 0, Number(next.revision) || 0) + 1
    const stamped = { ...next, revision, updatedAt: Date.now() }
    applyRoom(stamped)
    broadcastState(stamped)
    return stamped
  }, [applyRoom, broadcastState])

  const showToast = useCallback((text, tone = 'info') => {
    window.clearTimeout(toastTimerRef.current)
    setToast({ text, tone, id: Date.now() })
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2200)
  }, [])

  const award = useCallback((entries) => {
    if (!Array.isArray(entries) || entries.length === 0) return
    setStats((prev) => {
      const seen = new Set(prev.seen)
      let changed = false
      let score = prev.score
      let wins = prev.wins
      let questions = prev.questions
      for (const entry of entries) {
        if (!entry || typeof entry.key !== 'string' || seen.has(entry.key)) continue
        seen.add(entry.key)
        changed = true
        score = Math.min(COUNT_CAP, score + clamp(Math.floor(Number(entry.points) || 0), 0, 50))
        if (entry.kind === 'wins') wins += 1
        else if (entry.kind === 'questions') questions += 1
      }
      if (!changed) return prev
      return {
        ...prev,
        score,
        wins,
        questions,
        seen: [...seen].slice(-MAX_SEEN),
      }
    })
  }, [])

  useEffect(() => {
    statsRef.current = stats
  }, [stats])

  useEffect(() => {
    if (!userId) return undefined
    let cancelled = false
    supabase
      .from('profiles')
      .select('nickname')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        const name = cleanText(data?.nickname, MAX_NAME) || '匿名侦探'
        nicknameRef.current = name
        setNickname(name)
      })
      .catch(() => {
        if (cancelled) return
        nicknameRef.current = '匿名侦探'
        setNickname('匿名侦探')
      })
    return () => { cancelled = true }
  }, [userId])

  useEffect(() => {
    if (!userId) return
    saveStats(userId, stats)
  }, [stats, userId])

  useEffect(() => () => {
    window.clearTimeout(toastTimerRef.current)
    window.clearTimeout(presenceTimerRef.current)
    window.clearTimeout(helloTimerRef.current)
    for (const timer of aceRetryTimersRef.current) window.clearTimeout(timer)
    aceRetryTimersRef.current.clear()
  }, [])

  useEffect(() => {
    if (!room?.roundId) return
    setQuestionDraft('')
    setGuessDraft('')
  }, [room?.roundId])

  // 开局后所有端都把难度按钮切到本局档案的难度；结案后默认沿用上一局。
  useEffect(() => {
    if (!room?.puzzleId) return
    const soup = TURTLE_BY_ID[room.puzzleId]
    if (soup && Object.prototype.hasOwnProperty.call(TURTLE_DIFFICULTY, soup.difficulty)) {
      setSelectedDifficulty(soup.difficulty)
    }
  }, [room?.puzzleId])

  const selfMeta = useMemo(() => ({
    sid: sessionId,
    pid: playerId,
    name: nickname || '匿名侦探',
    joinedAt,
    score: stats.score,
    isSelf: true,
  }), [sessionId, playerId, nickname, joinedAt, stats.score])

  const displayPlayers = useMemo(() => {
    const bySid = new Map()
    for (const player of players) {
      if (player?.sid && player.sid !== sessionId) bySid.set(player.sid, player)
    }
    if (playerId) bySid.set(sessionId, { ...selfMeta, isSelf: true })
    return [...bySid.values()].sort(hostOrder).slice(0, MAX_PLAYERS)
  }, [players, playerId, selfMeta, sessionId])

  // 必须等自己的 presence 也到了再选主持端：新开/重连后的第一帧如果只有
  // “本机兜底玩家”，会把每个观众短暂误判成主持端，并向频道广播一次空房间。
  const selfPresenceSeen = players.some((player) => player.sid === sessionId)
  const hostCandidate = onlineReady && selfPresenceSeen && displayPlayers.length > 0
    ? displayPlayers[0]
    : null
  const isHost = Boolean(hostCandidate && hostCandidate.sid === sessionId)
  const isHostRef = useRef(false)

  useEffect(() => {
    isHostRef.current = isHost
  }, [isHost])

  const sendCurrentRoom = useCallback(() => {
    if (!isHostRef.current) return
    const current = roomRef.current
    if (!current) {
      commitRoom(emptyRoom(sessionId, playerId))
      return
    }
    if (current.hostSid !== sessionId) {
      commitRoom({ ...current, hostSid: sessionId, hostPid: playerId })
      return
    }
    broadcastState(current)
  }, [broadcastState, commitRoom, playerId, sessionId])

  // ── Ace 的操作（只在实际主持端的浏览器里执行）──────────────────
  const startRound = useCallback((puzzleId) => {
    if (!isHostRef.current) return
    const puzzle = TURTLE_BY_ID[puzzleId]
    if (!puzzle) return
    const current = roomRef.current ?? emptyRoom(sessionId, playerId)
    // 自动抽题和手动选题都在这里落 played；这样中途离开也算玩过。
    const played = markTurtlePlayed(current.played, puzzle)
    commitRoom({
      ...emptyRoom(sessionId, playerId),
      played,
      puzzleId: puzzle.id,
      status: 'playing',
      roundId: `round-${randomToken()}`,
      startedAt: Date.now(),
      revision: current.revision,
    })
    const level = TURTLE_DIFFICULTY[puzzle.difficulty]
    showToast(
      `Ace 开卷：${puzzle.title}${level ? `（${level.label} · 猜中 +${level.points}）` : ''}`,
      'good',
    )
  }, [commitRoom, playerId, sessionId, showToast])

  const revealRound = useCallback(() => {
    if (!isHostRef.current) return
    const current = roomRef.current
    if (!current || current.status !== 'playing') return
    commitRoom({
      ...current,
      status: 'ended',
      endedAt: Date.now(),
      endReason: 'revealed',
      winnerSid: '',
      winnerPid: '',
      winnerName: '',
      winningGuess: '',
    })
    showToast('Ace 揭开汤底，本局结案', 'info')
  }, [commitRoom, showToast])

  // ── 房间队列（只排队，不判定）──────────────────────────────────
  // 这两步只把条目以 pending 状态放进房间；判定由外部 Ace 广播 ace-verdict。
  const addQuestion = useCallback((raw) => {
    if (!isHostRef.current) return
    const current = roomRef.current
    if (!current || current.status !== 'playing') return
    // 上一局的迟到问题不能塞进新一局；这也挡住旧版客户端没有这两个字段的包。
    if (cleanId(raw?.puzzleId) !== current.puzzleId || cleanId(raw?.roundId) !== current.roundId) return
    const question = sanitizeQuestion(raw)
    if (!question) return
    if (current.questions.some((item) => item.id === question.id)) return
    const askedBy = playersRef.current.find((player) => player.sid === question.sid)
    const entry = {
      ...question,
      // 玩家可能刚改昵称、presence 还没追上：别让一条旧昵称把它盖回“匿名侦探”。
      name: question.name !== '匿名侦探'
        ? question.name
        : (askedBy?.name || question.name),
      // 用主持端收到的时间做 5 秒计时基准，减少各端时钟差。
      at: Date.now(),
      verdict: '',
      // 判定前不接受请求里自带的引导，等 ace-verdict 再写。
      reply: '',
      answeredAt: 0,
    }
    commitRoom({
      ...current,
      questions: [...current.questions, entry].slice(-MAX_QUESTIONS),
    })
  }, [commitRoom])

  const addGuess = useCallback((raw) => {
    if (!isHostRef.current) return
    const current = roomRef.current
    if (!current || current.status !== 'playing') return
    if (cleanId(raw?.puzzleId) !== current.puzzleId || cleanId(raw?.roundId) !== current.roundId) return
    const guess = sanitizeGuess(raw)
    if (!guess) return
    if (current.guesses.some((item) => item.id === guess.id)) return
    const guessedBy = playersRef.current.find((player) => player.sid === guess.sid)
    const entry = {
      ...guess,
      name: guess.name !== '匿名侦探'
        ? guess.name
        : (guessedBy?.name || guess.name),
      at: Date.now(),
      verdict: 'pending',
      reply: '',
      judgedAt: 0,
    }
    commitRoom({
      ...current,
      guesses: [...current.guesses, entry].slice(-MAX_GUESSES),
    })
  }, [commitRoom])

  const applyAceVerdict = useCallback(function applyAceVerdict(raw, attempt = 0) {
    const verdict = sanitizeAceVerdict(raw)
    if (!verdict) return
    const current = roomRef.current
    if (!current || current.status !== 'playing') return
    if (verdict.puzzleId !== current.puzzleId || verdict.roundId !== current.roundId) return

    // 每个客户端都先接住判定，避免只依赖一次 state 广播；只有房间汇总端
    // 负责把新快照再广播出去。迟到的判定同样能覆盖 5 秒超时提示。
    const publish = (next) => {
      if (isHostRef.current) commitRoom(next)
      else applyRoom({ ...next, updatedAt: Date.now() })
    }

    // 判定可能先于房间快照到达；最多重试 2.4 秒，等条目出现后再落判定。
    const retry = () => {
      if (attempt >= 12) return
      const timer = window.setTimeout(() => {
        aceRetryTimersRef.current.delete(timer)
        applyAceVerdict(raw, attempt + 1)
      }, 200)
      aceRetryTimersRef.current.add(timer)
    }

    if (verdict.kind === 'question') {
      const target = current.questions.find((item) => item.id === verdict.requestId)
      if (!target) {
        retry()
        return
      }
      if (target.verdict) return
      publish({
        ...current,
        questions: current.questions.map((item) => (
          item.id === verdict.requestId
            ? {
              ...item,
              verdict: verdict.verdict,
              reply: verdict.reply,
              answeredAt: Date.now(),
            }
            : item
        )),
      })
      return
    }

    const target = current.guesses.find((item) => item.id === verdict.requestId)
    if (!target) {
      retry()
      return
    }
    if (target.verdict !== 'pending') return
    const guesses = current.guesses.map((item) => (
      item.id === verdict.requestId
        ? {
          ...item,
          verdict: verdict.verdict,
          reply: verdict.reply,
          judgedAt: Date.now(),
        }
        : item
    ))

    if (verdict.verdict === 'correct') {
      publish({
        ...current,
        guesses,
        status: 'ended',
        endedAt: Date.now(),
        endReason: 'guessed',
        winnerSid: target.sid,
        winnerPid: target.pid,
        winnerName: target.name,
        winningGuess: target.text,
      })
      if (isHostRef.current) showToast(`Ace 判定：${target.name} 猜中了汤底`, 'good')
      return
    }

    publish({ ...current, guesses })
    if (isHostRef.current) showToast(`Ace 判定：${target.name} 还不对`, 'info')
  }, [applyRoom, commitRoom, showToast])

  const handleAceRequest = useCallback((raw) => {
    if (!isHostRef.current) return
    const request = sanitizeAceRequest(raw)
    if (!request) return
    const current = roomRef.current
    if (request.action === 'start') {
      if (current?.status === 'playing') return
      startRound(
        request.puzzleId
          || pickTurtle(request.difficulty, current?.played ?? [], current?.puzzleId ?? '').id,
      )
      return
    }
    if (current?.status !== 'playing') return
    revealRound()
  }, [revealRound, startRound])

  const requestAce = useCallback((action, puzzleId = '', difficulty = '') => {
    if (!onlineReady || !playerId) {
      showToast('频道还没连上，稍等一下', 'bad')
      return
    }
    const chosenDifficulty = Object.prototype.hasOwnProperty.call(TURTLE_DIFFICULTY, difficulty)
      ? difficulty
      : selectedDifficulty
    const request = {
      id: `req-${randomToken()}`,
      sid: sessionId,
      pid: playerId,
      action: action === 'reveal' ? 'reveal' : 'start',
      puzzleId: Object.prototype.hasOwnProperty.call(TURTLE_BY_ID, puzzleId) ? puzzleId : '',
      difficulty: action === 'reveal' ? '' : chosenDifficulty,
      at: Date.now(),
    }
    if (isHostRef.current) {
      handleAceRequest(request)
      return
    }
    if (!sendBroadcast('ace-request', request)) {
      showToast('频道还没连上，稍等一下', 'bad')
      return
    }
    const level = TURTLE_DIFFICULTY[chosenDifficulty]
    showToast(
      request.action === 'reveal'
        ? '已向 Ace 投降，等揭底…'
        : `已请 Ace 出题（${level?.label ?? '随机'}）…`,
      'info',
    )
  }, [handleAceRequest, onlineReady, playerId, selectedDifficulty, sendBroadcast, sessionId, showToast])

  // 手动挑档案时，把难度选择同步到那张档案，避免下一局还停留在旧难度。
  const startPicked = useCallback((puzzleId) => {
    const soup = TURTLE_BY_ID[puzzleId]
    if (!soup) return
    if (Object.prototype.hasOwnProperty.call(TURTLE_DIFFICULTY, soup.difficulty)) {
      setSelectedDifficulty(soup.difficulty)
    }
    requestAce('start', soup.id, soup.difficulty)
  }, [requestAce])

  // 主持端开局：第一次连上时先建一个空房间；原主持端离开后由下一位接手。
  useEffect(() => {
    if (!userId || !playerId || !onlineReady || !isHost) return
    const current = roomRef.current
    if (!current) {
      commitRoom(emptyRoom(sessionId, playerId))
      return
    }
    if (current.hostSid !== sessionId) {
      commitRoom({ ...current, hostSid: sessionId, hostPid: playerId })
    }
  }, [userId, playerId, sessionId, onlineReady, isHost, commitRoom])

  // 公共频道挂载：presence 负责在线玩家和主持端选举，broadcast 负责房间状态。
  useEffect(() => {
    if (!userId || !playerId) return undefined
    let cancelled = false
    const channel = supabase.channel(CHANNEL_NAME, {
      config: { presence: { key: sessionId } },
    })
    channelRef.current = channel

    const trackSelf = () => {
      try {
        Promise.resolve(channel.track({
          sid: sessionId,
          pid: playerId,
          name: nicknameRef.current || '匿名侦探',
          joinedAt,
          score: statsRef.current.score,
          ts: Date.now(),
        })).catch(() => {})
      } catch {
        /* 频道未就绪，等下一次 presence 同步 */
      }
    }

    const broadcast = (event, payload) => {
      try {
        Promise.resolve(channel.send({ type: 'broadcast', event, payload })).catch(() => {})
      } catch {
        /* 不影响本机界面 */
      }
    }

    const requestState = () => {
      broadcast('hello', { sid: sessionId, pid: playerId, at: Date.now() })
    }

    channel.on('presence', { event: 'sync' }, () => {
      if (cancelled) return
      const state = channel.presenceState()
      const bySid = new Map()
      for (const entries of Object.values(state)) {
        if (!Array.isArray(entries)) continue
        for (const raw of entries) {
          const player = sanitizePlayer(raw)
          if (!player) continue
          const previous = bySid.get(player.sid)
          if (!previous || player.ts >= previous.ts) bySid.set(player.sid, player)
        }
      }
      const list = [...bySid.values()].sort(hostOrder).slice(0, MAX_PLAYERS)
      playersRef.current = list
      setPlayers(list)

      // 新玩家可能错过了上一份房间快照：主持端补发一次。
      if (isHostRef.current) {
        window.clearTimeout(presenceTimerRef.current)
        presenceTimerRef.current = window.setTimeout(() => {
          if (!cancelled) sendCurrentRoom()
        }, 220)
      } else if (!roomRef.current) {
        window.clearTimeout(helloTimerRef.current)
        helloTimerRef.current = window.setTimeout(() => {
          if (!cancelled) requestState()
        }, 300)
      }
    })

    channel.on('broadcast', { event: 'hello' }, ({ payload }) => {
      if (cancelled || !isHostRef.current) return
      if (!payload || cleanId(payload.sid) === sessionId) return
      window.clearTimeout(presenceTimerRef.current)
      presenceTimerRef.current = window.setTimeout(() => {
        if (!cancelled) sendCurrentRoom()
      }, 80)
    })

    channel.on('broadcast', { event: 'state' }, ({ payload }) => {
      if (cancelled || !payload) return
      const from = cleanId(payload.from)
      if (!from || from === sessionId) return
      const expectedHost = playersRef.current.length > 0
        ? [...playersRef.current].sort(hostOrder)[0]?.sid
        : ''
      if (expectedHost && from !== expectedHost) return
      const next = sanitizeRoom(payload.state, from)
      if (!next || next.hostSid !== from) return
      const current = roomRef.current
      if (current && current.hostSid === next.hostSid && next.revision <= current.revision) return
      applyRoom(next)
    })

    // 提问和猜测只排队，不在这里判定；外部 Ace 收到同一条广播后回 ace-verdict。
    // 主持端自己提问/猜底时也会走本地 addQuestion/addGuess（见 submit）。
    // 这里不按发送者过滤：supabase 可能把广播回显给发送端，重复由 id 去重。
    channel.on('broadcast', { event: 'question' }, ({ payload }) => {
      if (cancelled) return
      addQuestion(payload)
    })

    channel.on('broadcast', { event: 'guess' }, ({ payload }) => {
      if (cancelled) return
      addGuess(payload)
    })

    // 外部 Ace 的判定只回判定词；由当前房间汇总端写进快照再广播。
    // 迟到的判定也收：若客户端已经显示 5 秒超时，这里会把它覆盖成真实结果。
    channel.on('broadcast', { event: 'ace-verdict' }, ({ payload }) => {
      if (cancelled) return
      applyAceVerdict(payload)
    })

    // 任何玩家都可以请 Ace 出题或投降揭底；真正执行的是当前主持端。
    channel.on('broadcast', { event: 'ace-request' }, ({ payload }) => {
      if (cancelled) return
      handleAceRequest(payload)
    })

    channel.subscribe((status) => {
      if (cancelled) return
      if (status === 'SUBSCRIBED') {
        setOnlineReady(true)
        setChannelStatus('online')
        trackSelf()
        window.clearTimeout(helloTimerRef.current)
        helloTimerRef.current = window.setTimeout(() => {
          if (!cancelled) requestState()
        }, 350)
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setOnlineReady(false)
        setChannelStatus('offline')
        playersRef.current = []
        setPlayers([])
      }
    })

    return () => {
      cancelled = true
      window.clearTimeout(presenceTimerRef.current)
      window.clearTimeout(helloTimerRef.current)
      channelRef.current = null
      supabase.removeChannel(channel)
    }
  }, [userId, playerId, sessionId, joinedAt, applyRoom, commitRoom, sendCurrentRoom, addQuestion, addGuess, applyAceVerdict, handleAceRequest])

  // 昵称 / 积分变化后刷新 presence，在线侦探名单里能看到最新分数。
  useEffect(() => {
    if (!onlineReady || !userId || !playerId) return undefined
    const channel = channelRef.current
    if (!channel) return undefined
    const timer = window.setTimeout(() => {
      try {
        Promise.resolve(channel.track({
          sid: sessionId,
          pid: playerId,
          name: nickname || '匿名侦探',
          joinedAt,
          score: stats.score,
          ts: Date.now(),
        })).catch(() => {})
      } catch {
        /* 忽略：下一次 presence 同步会重来 */
      }
    }, 180)
    return () => window.clearTimeout(timer)
  }, [onlineReady, userId, playerId, sessionId, joinedAt, nickname, stats.score])

  // 猜中汤底按本局难度加分：入门 +10 / 进阶 +20 / 烧脑 +30。
  // 只奖励本机玩家，按 roundId 去重，刷新/重连不会重复加。
  useEffect(() => {
    if (!room || room.status !== 'ended' || !room.roundId || !playerId) return
    if (room.winnerPid && room.winnerPid === playerId) {
      const soup = TURTLE_BY_ID[room.puzzleId]
      const points = TURTLE_DIFFICULTY[soup?.difficulty]?.points ?? TURTLE_DIFFICULTY.easy.points
      award([{ key: `${room.roundId}:win`, kind: 'wins', points }])
    }
  }, [room, playerId, award])

  // 只有 Ace 判「是」的有效提问 +1；no / partial / irrelevant / 超时都不计。
  useEffect(() => {
    if (!room || room.status === 'lobby' || !room.roundId || !playerId) return
    award(turtleQuestionAwards(room, playerId))
  }, [room, playerId, award])

  const submitQuestion = (event) => {
    event.preventDefault()
    if (!onlineReady || !room || room.status !== 'playing' || !playerId) return
    const text = cleanText(questionDraft, MAX_QUESTION_TEXT)
    if (!text) return
    const now = Date.now()
    if (now - lastQuestionAtRef.current < QUESTION_COOLDOWN) {
      showToast('问得慢一点，Ace 正在看上一题', 'info')
      return
    }
    const payload = {
      id: `q-${randomToken()}`,
      sid: sessionId,
      pid: playerId,
      name: nickname || '匿名侦探',
      text,
      at: now,
      // 外部 Ace 靠这两个字段取对应汤底，并丢弃上一局的迟到请求。
      puzzleId: room.puzzleId,
      roundId: room.roundId,
    }
    // 主持端自己提问时，公共广播不会可靠地回到自己；本地只排进队列，
    // 判定仍然等外部 Ace 的 ace-verdict。
    const sent = sendBroadcast('question', payload)
    if (isHostRef.current) addQuestion(payload)
    if (!sent && !isHostRef.current) {
      showToast('发送失败，再试一次', 'bad')
      return
    }
    lastQuestionAtRef.current = now
    setQuestionDraft('')
    showToast('问题已交给 Ace，等判定…', 'good')
  }

  const submitGuess = (event) => {
    event.preventDefault()
    if (!onlineReady || !room || room.status !== 'playing' || !playerId) return
    const text = cleanText(guessDraft, MAX_GUESS_TEXT)
    if (!text) return
    const payload = {
      id: `g-${randomToken()}`,
      sid: sessionId,
      pid: playerId,
      name: nickname || '匿名侦探',
      text,
      at: Date.now(),
      puzzleId: room.puzzleId,
      roundId: room.roundId,
    }
    const sent = sendBroadcast('guess', payload)
    if (isHostRef.current) addGuess(payload)
    if (!sent && !isHostRef.current) {
      showToast('发送失败，再试一次', 'bad')
      return
    }
    setGuessDraft('')
    showToast('猜测已交给 Ace，等判定…', 'good')
  }

  const puzzle = room?.puzzleId ? (TURTLE_BY_ID[room.puzzleId] ?? null) : null
  const status = room?.status ?? 'lobby'
  const difficultyMeta = puzzle ? TURTLE_DIFFICULTY[puzzle.difficulty] : null
  const openingLine = difficultyMeta?.opening ?? ''
  const roundPoints = difficultyMeta?.points ?? TURTLE_DIFFICULTY.easy.points
  const selectedDifficultyMeta = TURTLE_DIFFICULTY[selectedDifficulty] ?? TURTLE_DIFFICULTY.easy
  const caseIndex = puzzle ? TURTLE_SOUPS.findIndex((soup) => soup.id === puzzle.id) + 1 : 0
  const caseNo = caseIndex > 0 ? String(caseIndex).padStart(2, '0') : '--'
  const onlineCount = onlineReady ? displayPlayers.length : 0
  const questions = room?.questions ?? []
  const answeredCount = questions.filter((question) => Boolean(question.verdict)).length
  const guesses = room?.guesses ?? []
  const ownGuesses = guesses.filter((guess) => guess.pid === playerId)
  const canPlay = Boolean(onlineReady && room && status === 'playing' && playerId)
  const canRequest = Boolean(onlineReady && playerId)
  const lobby = !puzzle || status === 'lobby'

  if (!userId) {
    return (
      <div className="turtle-page">
        <p className="turtle-empty">需要登录后才能开汤。</p>
      </div>
    )
  }

  return (
    <div
      className="turtle-page"
      data-turtle-game
      data-turtle-ace="true"
      data-turtle-ace-name="Ace"
      data-turtle-ace-mode="remote"
      data-turtle-ace-wait={ACE_WAIT_MS}
      data-turtle-channel={CHANNEL_NAME}
      data-turtle-status={status}
      data-turtle-host={isHost ? 'true' : 'false'}
      data-turtle-online={onlineReady ? 'true' : 'false'}
      data-turtle-online-count={onlineCount}
      data-turtle-round={room?.roundId ?? ''}
      data-turtle-selected-difficulty={selectedDifficulty}
      data-turtle-difficulty={puzzle?.difficulty ?? ''}
      data-turtle-points={puzzle ? roundPoints : ''}
    >
      <header className="turtle-top">
        <button type="button" className="turtle-back" onClick={onExit} aria-label="返回实验室">
          <span aria-hidden="true">←</span> 实验室
        </button>
        <div className="turtle-title">
          <p className="turtle-eyebrow">MOMENTS · CASE ROOM</p>
          <h2>海龟汤</h2>
        </div>
        <div className="turtle-score" aria-label={`本机侦探积分 ${stats.score}`}>
          <span>侦探积分</span>
          <strong data-turtle-score>{stats.score}</strong>
        </div>
      </header>

      <div className={`turtle-signal${onlineReady ? ' is-online' : ' is-offline'}`}>
        <span className="turtle-signal-dot" aria-hidden="true" />
        <span className="turtle-signal-copy">
          {onlineReady ? '公共频道在线' : channelStatus === 'offline' ? '频道已断开，正在重连…' : '正在连接公共频道…'}
        </span>
        <span className="turtle-signal-host">
          <span className="turtle-ace-name" data-turtle-ace-label>Ace 主持</span>
          <i aria-hidden="true">·</i>
          {onlineReady ? `${onlineCount} 人在线` : '离线'}
        </span>
      </div>

      {lobby ? (
        <section className="turtle-lobby" aria-labelledby="turtle-lobby-title">
          <div className="turtle-lobby-mark" aria-hidden="true">CASE FILE</div>
          <p className="turtle-eyebrow">ACE IS HOLDING THE FILE</p>
          <h3 id="turtle-lobby-title">Ace 主持 · 等一份卷宗</h3>
          <p className="turtle-lobby-copy">
            {onlineReady
              ? '任何玩家都可以请 Ace 出题。先选难度，点「请 Ace 出题」会从该难度随机抽一题；开汤后，Ace 会用「是 / 否 / 无关 / 部分」判定提问。'
              : '正在接入本场的公共频道。连上后，Ace 就会开始主持。'}
          </p>
          {canRequest && (
            <>
              <DifficultyPicker value={selectedDifficulty} onSelect={setSelectedDifficulty} />
              <button type="button" className="turtle-primary" onClick={() => requestAce('start')} data-turtle-start>
                请 Ace 出题 · {selectedDifficultyMeta.label} +{selectedDifficultyMeta.points}
              </button>
              <PuzzlePicker
                currentId={room?.puzzleId ?? ''}
                played={room?.played ?? []}
                onPick={startPicked}
              />
            </>
          )}
          <p className="turtle-lobby-note">
            入门 +{TURTLE_DIFFICULTY.easy.points} / 进阶 +{TURTLE_DIFFICULTY.medium.points} /
            烧脑 +{TURTLE_DIFFICULTY.hard.points}；猜中汤底得对应分值，Ace 判「是」的有效提问每题 +1。
            同一难度会避开已玩档案，全玩完才重开一轮；手动挑档案也算已玩。
            Ace 由外部常驻主持端承担，界面固定显示 Ace；出题后，任何时候都能投降揭底。
          </p>
        </section>
      ) : (
        <section
          className={`turtle-case is-${puzzle.difficulty}`}
          data-turtle-case
          data-turtle-puzzle={puzzle.id}
          data-turtle-difficulty={puzzle.difficulty}
          data-turtle-points={roundPoints}
          aria-labelledby="turtle-case-title"
        >
          <div className="turtle-case-tab">
            <span>CASE</span>
            <strong>{caseNo}</strong>
          </div>
          <div className="turtle-case-meta">
            <span
              className="turtle-diff"
              style={{ '--turtle-diff': TURTLE_DIFFICULTY[puzzle.difficulty]?.color }}
              data-turtle-case-difficulty={puzzle.difficulty}
            >
              {TURTLE_DIFFICULTY[puzzle.difficulty]?.label ?? '档案'}
            </span>
            <span className="turtle-diff-stake" data-turtle-case-points={roundPoints}>
              猜中 +{roundPoints}
            </span>
            <span>{puzzle.theme}</span>
            <span>{STATUS_LABEL[status] ?? '推理中'}</span>
          </div>
          <h3 id="turtle-case-title">{puzzle.title}</h3>
          <div className="turtle-surface">
            <span className="turtle-surface-label">汤 面</span>
            <p>{puzzle.surface}</p>
          </div>
          <div className="turtle-tags">
            {puzzle.tags.map((tag) => <span key={tag}>#{tag}</span>)}
          </div>
        </section>
      )}

      {puzzle && status === 'playing' && (
        <section className="turtle-ace-console" aria-label="Ace 主持台">
          <div className="turtle-ace-console-copy">
            <strong><span className="turtle-ace-dot" aria-hidden="true" />Ace 主持</strong>
            {openingLine && (
              <p className="turtle-ace-opening" data-turtle-ace-opening={puzzle.difficulty}>
                {openingLine}
              </p>
            )}
            <p>
              已等到 {answeredCount} 个提问判定、{guesses.length} 条猜底结果。
              任何人投降，Ace 都会立刻揭底。
            </p>
          </div>
          <button
            type="button"
            className="turtle-danger"
            onClick={() => requestAce('reveal')}
            disabled={!canRequest}
            data-turtle-reveal
          >
            投降，揭底
          </button>
        </section>
      )}

      {puzzle && status === 'playing' && (
        <section className="turtle-player-desk" aria-label="提问和猜汤底">
          <form className="turtle-form" onSubmit={submitQuestion} data-turtle-question-form>
            <label htmlFor="turtle-question-input">
              <span className="turtle-form-label">提一个问题</span>
              <small>Ace 会用「是 / 否 / 无关 / 部分」回答</small>
            </label>
            <div className="turtle-input-row">
              <input
                id="turtle-question-input"
                type="text"
                value={questionDraft}
                onChange={(event) => setQuestionDraft(event.target.value)}
                onKeyDown={imeGuard}
                maxLength={MAX_QUESTION_TEXT}
                placeholder="例如：他是在等人吗？"
                autoComplete="off"
                disabled={!canPlay}
                data-turtle-question-input
              />
              <button type="submit" className="turtle-primary" disabled={!canPlay || !questionDraft.trim()} data-turtle-question-send>
                提问
              </button>
            </div>
          </form>

          <form className="turtle-form turtle-guess-form" onSubmit={submitGuess} data-turtle-guess-form>
            <label htmlFor="turtle-guess-input">
              <span className="turtle-form-label">直接猜汤底</span>
              <small>Ace 在线时判定是否猜中</small>
            </label>
            <div className="turtle-input-row">
              <input
                id="turtle-guess-input"
                type="text"
                value={guessDraft}
                onChange={(event) => setGuessDraft(event.target.value)}
                onKeyDown={imeGuard}
                maxLength={MAX_GUESS_TEXT}
                placeholder="我觉得真相是……"
                autoComplete="off"
                disabled={!canPlay}
                data-turtle-guess-input
              />
              <button type="submit" className="turtle-danger" disabled={!canPlay || !guessDraft.trim()} data-turtle-guess-send>
                交给 Ace
              </button>
            </div>
          </form>

          {ownGuesses.length > 0 && (
            <div className="turtle-own-guesses">
              <p className="turtle-own-guesses-title">你的猜测</p>
              {ownGuesses.map((guess) => {
                const timedOut = isGuessTimedOut(guess)
                const state = guess.verdict === 'pending' && timedOut ? 'timeout' : guess.verdict
                return (
                  <p className="turtle-own-guess" key={guess.id} data-turtle-own-guess={state}>
                    <span>“{guess.text}”</span>
                    <span className="turtle-own-guess-result">
                      <strong>
                        {state === 'correct'
                          ? 'Ace：猜中'
                          : state === 'wrong'
                            ? 'Ace：不对'
                            : state === 'timeout'
                              ? 'Ace 不在线，没判'
                              : 'Ace 正在判定'}
                      </strong>
                      {(state === 'correct' || state === 'wrong') && (
                        <span
                          className="turtle-ace-note"
                          data-turtle-own-guess-reply={guess.reply || ''}
                          data-turtle-reply-source={guess.reply ? 'ace' : 'template'}
                        >
                          {guess.reply || GUESS_NOTE[state]}
                        </span>
                      )}
                    </span>
                  </p>
                )
              })}
            </div>
          )}
          {!onlineReady && <p className="turtle-offline-note">频道断开时不能提问；连接恢复后会自动重试。</p>}
        </section>
      )}

      {puzzle && status !== 'lobby' && (
        <section className="turtle-ledger" aria-labelledby="turtle-ledger-title">
          <div className="turtle-section-head">
            <h3 id="turtle-ledger-title">问答记录</h3>
            <span>{questions.length} 问 · {answeredCount} 答</span>
          </div>
          {questions.length === 0 ? (
            <p className="turtle-empty">
              还没有人提问。问得越具体，Ace 越好回答。
            </p>
          ) : (
            <ol className="turtle-question-list">
              {questions.map((question, index) => {
                const timedOut = isQuestionTimedOut(question)
                const state = question.verdict || (timedOut ? 'timeout' : 'pending')
                return (
                  <li
                    key={question.id}
                    className={`turtle-question${question.verdict ? ' is-answered' : ''}${state === 'timeout' ? ' is-timeout' : ''}`}
                    data-turtle-question
                    data-turtle-question-id={question.id}
                    data-question-verdict={state}
                  >
                    <span className="turtle-question-no" aria-hidden="true">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <div className="turtle-question-body">
                      <div className="turtle-question-meta">
                        <strong>{question.pid && question.pid === playerId ? '你' : question.name}</strong>
                        <span>{formatClock(question.at)}</span>
                      </div>
                      <p className="turtle-question-text">{question.text}</p>
                      {question.verdict ? (
                        <span className="turtle-ace-answer" data-turtle-ace-answer={question.verdict}>
                          <span className="turtle-ace-byline">Ace</span>
                          <VerdictChip verdict={question.verdict} />
                          <span
                            className="turtle-ace-note"
                            data-turtle-ace-note={question.verdict}
                            data-turtle-ace-reply={question.reply || ''}
                            data-turtle-reply-source={question.reply ? 'ace' : 'template'}
                          >
                            {question.reply || QUESTION_NOTE[question.verdict]}
                          </span>
                        </span>
                      ) : state === 'timeout' ? (
                        <span className="turtle-verdict-wait is-timeout" data-turtle-ace-timeout="question">
                          Ace 不在线，这题没答。可以再问一次。
                        </span>
                      ) : (
                        <span className="turtle-verdict-wait">Ace 正在看…</span>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </section>
      )}

      {puzzle && status !== 'lobby' && guesses.length > 0 && (
        <section className="turtle-guess-log" aria-labelledby="turtle-guess-log-title">
          <div className="turtle-section-head">
            <h3 id="turtle-guess-log-title">猜测记录</h3>
            <span>Ace 在线判定</span>
          </div>
          <ul className="turtle-guess-list">
            {guesses.map((guess) => {
              const timedOut = isGuessTimedOut(guess)
              const state = guess.verdict === 'pending' && timedOut ? 'timeout' : guess.verdict
              return (
                <li
                  className={`turtle-guess is-${state}`}
                  key={guess.id}
                  data-turtle-guess
                  data-guess-verdict={state}
                >
                  <div className="turtle-guess-meta">
                    <strong>{guess.pid && guess.pid === playerId ? '你' : guess.name}</strong>
                    <span>{formatClock(guess.at)}</span>
                  </div>
                  <p className="turtle-guess-text">{guess.text}</p>
                  <span className={`turtle-guess-state is-${state}`} data-turtle-ace-judge={state}>
                    {state === 'correct'
                      ? 'Ace：猜中，结案'
                      : state === 'wrong'
                        ? 'Ace：还不对'
                        : state === 'timeout'
                          ? 'Ace 不在线，这题没判。可以再猜一次。'
                          : 'Ace 正在判定…'}
                  </span>
                  {(state === 'correct' || state === 'wrong') && (
                    <span
                      className="turtle-ace-note"
                      data-turtle-ace-note={state}
                      data-turtle-ace-reply={guess.reply || ''}
                      data-turtle-reply-source={guess.reply ? 'ace' : 'template'}
                    >
                      {guess.reply || GUESS_NOTE[state]}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {puzzle && status === 'ended' && (
        <section
          className={`turtle-reveal is-${room?.endReason ?? 'revealed'}`}
          data-turtle-reveal-panel
          data-turtle-end-reason={room?.endReason ?? 'revealed'}
          aria-labelledby="turtle-reveal-title"
        >
          <div className="turtle-stamp" aria-hidden="true">结案</div>
          <p className="turtle-eyebrow">
            {room?.endReason === 'guessed' ? 'GUESSED · 猜中' : 'ACE REVEALED · 投降揭底'}
          </p>
          <h3 id="turtle-reveal-title" data-turtle-reveal-title>
            {room?.endReason === 'guessed' ? '有人猜中了汤底' : 'Ace 揭开了汤底'}
          </h3>
          <p className="turtle-round-stake" data-turtle-reveal-points={roundPoints}>
            本局 {difficultyMeta?.label ?? '档案'} · 猜中 +{roundPoints} 分
          </p>
          {room?.endReason === 'guessed' && room?.winnerName && (
            <p className="turtle-winner">
              猜中者：<strong>{room.winnerName}</strong>
              {room.winnerPid && room.winnerPid === playerId ? '（你）' : ''}
              {room.winningGuess ? <span>“{room.winningGuess}”</span> : null}
            </p>
          )}
          <div className="turtle-truth is-public" data-turtle-truth>
            <div className="turtle-truth-head">
              <span>CASE CLOSED · ACE</span>
              <strong>{puzzle.title} · 汤底</strong>
            </div>
            <p>{puzzle.solution}</p>
          </div>
          <div className="turtle-reveal-actions">
            <DifficultyPicker value={selectedDifficulty} onSelect={setSelectedDifficulty} />
            <button
              type="button"
              className="turtle-primary"
              onClick={() => requestAce('start')}
              disabled={!canRequest}
              data-turtle-next
            >
              请 Ace 再出一题 · {selectedDifficultyMeta.label} +{selectedDifficultyMeta.points}
            </button>
            <PuzzlePicker
              currentId={puzzle.id}
              played={room?.played ?? []}
              onPick={startPicked}
              compact
            />
          </div>
        </section>
      )}

      <div className="turtle-meta-grid">
        <section className="turtle-players" aria-labelledby="turtle-players-title">
          <div className="turtle-section-head">
            <h3 id="turtle-players-title">在线侦探</h3>
            <span>{onlineCount} 人</span>
          </div>
          {onlineReady ? (
            <ul className="turtle-player-list">
              {displayPlayers.map((player) => (
                <li
                  className={`turtle-player${player.sid === sessionId ? ' is-self' : ''}`}
                  key={player.sid}
                  data-turtle-player
                  data-turtle-player-self={player.sid === sessionId ? 'true' : 'false'}
                >
                  <span className="turtle-avatar" aria-hidden="true">{player.name.slice(0, 1)}</span>
                  <span className="turtle-player-copy">
                    <strong>
                      {player.name}
                      {player.sid === sessionId ? '（你）' : ''}
                    </strong>
                    <small>
                      在席
                      <i aria-hidden="true">·</i>
                      {player.score} 分
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="turtle-empty">正在接入公共频道，在线名单会自己出现。</p>
          )}
        </section>

        <section className="turtle-score-card" aria-labelledby="turtle-score-title">
          <div className="turtle-section-head">
            <h3 id="turtle-score-title">本机档案</h3>
            <span>只记在这台设备</span>
          </div>
          <div className="turtle-score-grid">
            <span><small>积分</small><strong data-turtle-score-card>{stats.score}</strong></span>
            <span><small>猜中</small><strong>{stats.wins}</strong></span>
            <span><small>有效提问</small><strong>{stats.questions}</strong></span>
          </div>
          <p
            className="turtle-score-note"
            data-turtle-score-note
            data-turtle-round-difficulty={puzzle?.difficulty ?? ''}
            data-turtle-round-points={puzzle ? roundPoints : ''}
          >
            {puzzle
              ? `本局${difficultyMeta?.label ?? '档案'}，猜中 +${roundPoints}；`
              : `难度：入门 +${TURTLE_DIFFICULTY.easy.points} / 进阶 +${TURTLE_DIFFICULTY.medium.points} / 烧脑 +${TURTLE_DIFFICULTY.hard.points}；`}
            被 Ace 判「是」的有效提问每题 +1。Ace 主持，没有主持加分。
          </p>
        </section>
      </div>

      <details className="turtle-howto">
        <summary>怎么玩 · 海龟汤规则</summary>
        <ol>
          <li>Ace 主持：任何玩家都可以请 Ace 出题，汤底不会在播放中显示。</li>
          <li data-turtle-rules-difficulty>
            大厅/结案后可选难度：入门 +{TURTLE_DIFFICULTY.easy.points} /
            进阶 +{TURTLE_DIFFICULTY.medium.points} /
            烧脑 +{TURTLE_DIFFICULTY.hard.points}；点「请 Ace 出题」按所选难度随机。
            猜中汤底按本局难度加分，Ace 判「是」的有效提问每题 +1
            {puzzle ? `（本局${difficultyMeta?.label ?? '档案'}，猜中 +${roundPoints}）` : ''}。
          </li>
          <li>同一难度会避开已玩档案，全部玩完才重开一轮；手动挑档案也算已玩。</li>
          <li>玩家只能问能用「是 / 否 / 无关 / 部分」回答的问题，Ace 在线时回答。</li>
          <li>玩家可以随时提交完整猜测，Ace 在线时判定；猜中即结案。</li>
          <li>发出后 5 秒没有判定，会提示「Ace 不在线」，页面不会自己编答案。</li>
          <li>任何玩家都能「投降，揭底」；结案后任何人都能请 Ace 再出一题。</li>
          <li>本局内容通过 Supabase Realtime 公共频道同步。不建表、不写库、不广播账号 id。</li>
          <li>公共频道里提问和猜测对订阅者可见，别放真实隐私。Ace 主持是客户端约定，不是权限边界。</li>
        </ol>
      </details>

      <p className="turtle-foot">
        十份原创档案收在 <code>src/lab/turtleData.js</code>；判定由外部 Ace 主持端通过公共频道广播。
        换账号不会串积分；清空浏览器存储会重新开始。
      </p>

      {toast && (
        <div
          className={`turtle-toast is-visible${toast.tone === 'good' ? ' is-good' : ''}${toast.tone === 'bad' ? ' is-bad' : ''}`}
          role="status"
          aria-live="polite"
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}
