import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { useImeGuard } from '../lib/ime'
import {
  TURTLE_BY_ID,
  TURTLE_DIFFICULTY,
  TURTLE_SOUPS,
  pickTurtle,
} from './turtleData'

// ── 「海龟汤」多人游戏 ─────────────────────────────────────────────
// 玩法：一人主持（最早进入的人自动担任），其他人只提能用「是 / 否 /
// 无关 / 部分」回答的问题；主持人看得到汤底并逐条判定。有人猜中汤底、
// 或主持人主动揭底，本局结案，随后可以换题继续。
//
// 同步边界（实验室规矩）：
//   · 不建表、不写库：主持人的房间状态通过 Supabase Realtime 的公共频道
//     broadcast 下发；在线玩家用 presence 互通。
//   · 不广播账号 id：频道里用一次性会话 id（sid）和一个本机随机玩家 id（pid）。
//   · 汤底只渲染给主持人看；结案后才公开。汤底本身随前端包下发，
//     所以这是界面约束，不是安全边界。
//   · 公共频道里任何拿到 anon key 的人都能订阅，发送的提问/猜测不应包含隐私。
//
// 主持人 = presence 中最早进入的人；主持人离开后，下一位自动接手。
// 这是客户端的软角色：公共频道无法验证发送者身份，所有收到的状态都会先清洗。
const CHANNEL_NAME = 'moments-turtle-soup-v1'
const SCORE_PREFIX = 'moments-turtle-soup-score-v1:'
const PLAYER_PREFIX = 'moments-turtle-soup-player-v1:'
const COUNT_CAP = 999999
const MAX_NAME = 20
const MAX_QUESTION_TEXT = 140
const MAX_GUESS_TEXT = 180
const MAX_QUESTIONS = 60
const MAX_GUESSES = 40
const MAX_PLAYERS = 24
const MAX_SEEN = 240
const QUESTION_COOLDOWN = 800

const VERDICTS = [
  { id: 'yes', label: '是', hint: '符合汤底' },
  { id: 'no', label: '否', hint: '与汤底相反' },
  { id: 'irrelevant', label: '无关', hint: '和真相没关系' },
  { id: 'partial', label: '部分', hint: '对了一部分' },
]
const VERDICT_BY_ID = Object.fromEntries(VERDICTS.map((item) => [item.id, item]))
const STATUS_LABEL = { lobby: '候场', playing: '推理中', ended: '已结案' }

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
  return { v: 1, score: 0, wins: 0, questions: 0, hosted: 0, seen: [] }
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
      v: 1,
      score: sanitizeScore(parsed.score),
      wins: sanitizeCount(parsed.wins, 9999),
      questions: sanitizeCount(parsed.questions, 99999),
      hosted: sanitizeCount(parsed.hosted, 9999),
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
    judgedAt: safeTime(raw.judgedAt),
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

function PuzzlePicker({ currentId, onPick, compact = false }) {
  return (
    <details className={`turtle-archive${compact ? ' is-compact' : ''}`}>
      <summary>从十份档案里挑一题</summary>
      <div className="turtle-archive-grid">
        {TURTLE_SOUPS.map((soup, index) => {
          const difficulty = TURTLE_DIFFICULTY[soup.difficulty]
          return (
            <button
              key={soup.id}
              type="button"
              className={`turtle-archive-card${soup.id === currentId ? ' is-current' : ''}`}
              onClick={() => onPick(soup.id)}
              data-turtle-pick={soup.id}
            >
              <span className="turtle-archive-no">{String(index + 1).padStart(2, '0')}</span>
              <span className="turtle-archive-title">{soup.title}</span>
              <span className="turtle-archive-diff" style={{ '--turtle-diff': difficulty?.color }}>
                {difficulty?.label ?? '档案'}
              </span>
            </button>
          )
        })}
      </div>
    </details>
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

  const [room, setRoom] = useState(null)
  const roomRef = useRef(null)
  const [players, setPlayers] = useState([])
  const playersRef = useRef([])
  const [onlineReady, setOnlineReady] = useState(false)
  const [channelStatus, setChannelStatus] = useState('connecting')

  const [questionDraft, setQuestionDraft] = useState('')
  const [guessDraft, setGuessDraft] = useState('')
  const [truthOpen, setTruthOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)
  const [toast, setToast] = useState(null)

  const channelRef = useRef(null)
  const presenceTimerRef = useRef(0)
  const helloTimerRef = useRef(0)
  const toastTimerRef = useRef(0)
  const lastQuestionAtRef = useRef(0)
  const imeGuard = useImeGuard()

  const applyRoom = useCallback((next) => {
    roomRef.current = next
    setRoom(next)
  }, [])

  const broadcastState = useCallback((state) => {
    const channel = channelRef.current
    if (!channel || !state) return
    try {
      Promise.resolve(channel.send({
        type: 'broadcast',
        event: 'state',
        payload: { from: sessionId, state },
      })).catch(() => {})
    } catch {
      /* 频道刚好断开：下一次 presence 同步会再补一份 */
    }
  }, [sessionId])

  // 主持人每次改房间都整包广播：汤面、问答、判定、猜测和结案状态一次到位。
  // 公共频道不保证送达，所以 host 在 presence 变化时还会补发一次当前快照。
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
      let hosted = prev.hosted
      for (const entry of entries) {
        if (!entry || typeof entry.key !== 'string' || seen.has(entry.key)) continue
        seen.add(entry.key)
        changed = true
        score = Math.min(COUNT_CAP, score + clamp(Math.floor(Number(entry.points) || 0), 0, 50))
        if (entry.kind === 'wins') wins += 1
        else if (entry.kind === 'questions') questions += 1
        else if (entry.kind === 'hosted') hosted += 1
      }
      if (!changed) return prev
      return {
        ...prev,
        score,
        wins,
        questions,
        hosted,
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
  }, [])

  useEffect(() => {
    if (!room?.roundId) return
    setTruthOpen(false)
    setPendingAction(null)
  }, [room?.roundId])

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

  // 必须等自己的 presence 也到了再选主持人：新开/重连后的第一帧如果只有
  // “本机兜底玩家”，会把每个观众短暂误判成主持人，并向频道广播一次空房间。
  const selfPresenceSeen = players.some((player) => player.sid === sessionId)
  const hostCandidate = onlineReady && selfPresenceSeen && displayPlayers.length > 0
    ? displayPlayers[0]
    : null
  const isHost = Boolean(hostCandidate && hostCandidate.sid === sessionId)
  const hostName = hostCandidate?.name || '主持人'
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

  // 主持人开局：第一次连上时先建一个空房间；原主持人离开后由下一位接手。
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

  // 公共频道挂载：presence 负责在线玩家和主持人选举，broadcast 负责房间状态。
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

      // 新玩家可能错过了上一份房间快照：主持人补发一次。
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

    channel.on('broadcast', { event: 'question' }, ({ payload }) => {
      if (cancelled || !isHostRef.current) return
      const current = roomRef.current
      if (!current || current.status !== 'playing') return
      const question = sanitizeQuestion(payload)
      if (!question || question.sid === sessionId) return
      if (current.questions.some((item) => item.id === question.id)) return
      const askedBy = playersRef.current.find((player) => player.sid === question.sid)
      const questions = [...current.questions, {
        ...question,
        // 玩家可能刚改昵称、presence 还没追上：别让一条旧昵称把它盖回“匿名侦探”。
        name: question.name !== '匿名侦探'
          ? question.name
          : (askedBy?.name || question.name),
      }].slice(-MAX_QUESTIONS)
      commitRoom({ ...current, questions })
    })

    channel.on('broadcast', { event: 'guess' }, ({ payload }) => {
      if (cancelled || !isHostRef.current) return
      const current = roomRef.current
      if (!current || current.status !== 'playing') return
      const guess = sanitizeGuess(payload)
      if (!guess || guess.sid === sessionId) return
      if (current.guesses.some((item) => item.id === guess.id)) return
      const guessedBy = playersRef.current.find((player) => player.sid === guess.sid)
      const guesses = [...current.guesses, {
        ...guess,
        name: guess.name !== '匿名侦探'
          ? guess.name
          : (guessedBy?.name || guess.name),
        verdict: 'pending',
        judgedAt: 0,
      }].slice(-MAX_GUESSES)
      commitRoom({ ...current, guesses })
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
  }, [userId, playerId, sessionId, joinedAt, applyRoom, commitRoom, sendCurrentRoom])

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

  // 猜中汤底 +10。只奖励本机玩家，按 roundId 去重，刷新/重连不会重复加。
  useEffect(() => {
    if (!room || room.status !== 'ended' || !room.roundId || !playerId) return
    if (room.winnerPid && room.winnerPid === playerId) {
      award([{ key: `${room.roundId}:win`, kind: 'wins', points: 10 }])
    }
  }, [room, playerId, award])

  // 被主持人回答过的提问 +1（每题只记一次，不按判定结果分好坏）。
  useEffect(() => {
    if (!room || room.status === 'lobby' || !room.roundId || !playerId) return
    const entries = []
    for (const question of room.questions) {
      if (question.verdict && question.pid === playerId && question.id) {
        entries.push({
          key: `${room.roundId}:q:${question.id}`,
          kind: 'questions',
          points: 1,
        })
      }
    }
    award(entries)
  }, [room, playerId, award])

  const startRound = useCallback((puzzleId) => {
    if (!isHostRef.current) return
    const puzzle = TURTLE_BY_ID[puzzleId]
    if (!puzzle) return
    const current = roomRef.current ?? emptyRoom(sessionId, playerId)
    commitRoom({
      ...emptyRoom(sessionId, playerId),
      puzzleId: puzzle.id,
      status: 'playing',
      roundId: `round-${randomToken()}`,
      startedAt: Date.now(),
      revision: current.revision,
    })
    setTruthOpen(false)
    setPendingAction(null)
    showToast(`开汤：${puzzle.title}`, 'good')
  }, [commitRoom, playerId, sessionId, showToast])

  const startRandom = useCallback(() => {
    const current = roomRef.current
    startRound(pickTurtle(current?.puzzleId ?? '').id)
  }, [startRound])

  const answerQuestion = useCallback((questionId, verdict) => {
    if (!isHostRef.current || !VERDICT_BY_ID[verdict]) return
    const current = roomRef.current
    if (!current || current.status !== 'playing') return
    if (!current.questions.some((question) => question.id === questionId)) return
    commitRoom({
      ...current,
      questions: current.questions.map((question) => (
        question.id === questionId
          ? { ...question, verdict, answeredAt: Date.now() }
          : question
      )),
    })
  }, [commitRoom])

  const judgeGuess = useCallback((guessId, correct) => {
    if (!isHostRef.current) return
    const current = roomRef.current
    if (!current || current.status !== 'playing') return
    const target = current.guesses.find((guess) => guess.id === guessId)
    if (!target) return

    if (correct) {
      commitRoom({
        ...current,
        guesses: current.guesses.map((guess) => (
          guess.id === guessId
            ? { ...guess, verdict: 'correct', judgedAt: Date.now() }
            : guess
        )),
        status: 'ended',
        endedAt: Date.now(),
        endReason: 'guessed',
        winnerSid: target.sid,
        winnerPid: target.pid,
        winnerName: target.name,
        winningGuess: target.text,
      })
      award([{ key: `${current.roundId}:host`, kind: 'hosted', points: 3 }])
      setPendingAction(null)
      showToast('结案：汤底被猜中了', 'good')
      return
    }

    commitRoom({
      ...current,
      guesses: current.guesses.map((guess) => (
        guess.id === guessId
          ? { ...guess, verdict: 'wrong', judgedAt: Date.now() }
          : guess
      )),
    })
    showToast('已标记为猜错', 'info')
  }, [award, commitRoom, showToast])

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
    award([{ key: `${current.roundId}:host`, kind: 'hosted', points: 3 }])
    setPendingAction(null)
    showToast('已揭底，本局结案', 'info')
  }, [award, commitRoom, showToast])

  const submitQuestion = (event) => {
    event.preventDefault()
    if (!onlineReady || !room || room.status !== 'playing' || isHost || !playerId) return
    const text = cleanText(questionDraft, MAX_QUESTION_TEXT)
    if (!text) return
    const now = Date.now()
    if (now - lastQuestionAtRef.current < QUESTION_COOLDOWN) {
      showToast('问得慢一点，等主持人先看一眼', 'info')
      return
    }
    const channel = channelRef.current
    if (!channel) {
      showToast('频道还没连上，稍等一下', 'bad')
      return
    }
    try {
      Promise.resolve(channel.send({
        type: 'broadcast',
        event: 'question',
        payload: {
          id: `q-${randomToken()}`,
          sid: sessionId,
          pid: playerId,
          name: nickname || '匿名侦探',
          text,
          at: now,
        },
      })).catch(() => {})
    } catch {
      showToast('发送失败，再试一次', 'bad')
      return
    }
    lastQuestionAtRef.current = now
    setQuestionDraft('')
    showToast('问题已递给主持人', 'good')
  }

  const submitGuess = (event) => {
    event.preventDefault()
    if (!onlineReady || !room || room.status !== 'playing' || isHost || !playerId) return
    const text = cleanText(guessDraft, MAX_GUESS_TEXT)
    if (!text) return
    const channel = channelRef.current
    if (!channel) {
      showToast('频道还没连上，稍等一下', 'bad')
      return
    }
    try {
      Promise.resolve(channel.send({
        type: 'broadcast',
        event: 'guess',
        payload: {
          id: `g-${randomToken()}`,
          sid: sessionId,
          pid: playerId,
          name: nickname || '匿名侦探',
          text,
          at: Date.now(),
        },
      })).catch(() => {})
    } catch {
      showToast('发送失败，再试一次', 'bad')
      return
    }
    setGuessDraft('')
    showToast('猜测已交给主持人判定', 'good')
  }

  const puzzle = room?.puzzleId ? (TURTLE_BY_ID[room.puzzleId] ?? null) : null
  const status = room?.status ?? 'lobby'
  const caseIndex = puzzle ? TURTLE_SOUPS.findIndex((soup) => soup.id === puzzle.id) + 1 : 0
  const caseNo = caseIndex > 0 ? String(caseIndex).padStart(2, '0') : '--'
  const onlineCount = onlineReady ? displayPlayers.length : 0
  const questions = room?.questions ?? []
  const answeredCount = questions.filter((question) => Boolean(question.verdict)).length
  const guesses = room?.guesses ?? []
  const pendingGuesses = guesses.filter((guess) => guess.verdict === 'pending')
  const ownGuesses = guesses.filter((guess) => guess.pid === playerId)
  const canAsk = Boolean(onlineReady && room && status === 'playing' && !isHost && playerId)
  const canGuess = canAsk
  const actionLabel = pendingAction === 'reveal' ? '确认揭底' : '确认换题'

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
      data-turtle-status={status}
      data-turtle-host={isHost ? 'true' : 'false'}
      data-turtle-online={onlineReady ? 'true' : 'false'}
      data-turtle-online-count={onlineCount}
      data-turtle-round={room?.roundId ?? ''}
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
          {hostCandidate ? `主持人：${hostName}${isHost ? '（你）' : ''}` : '等待主持人'}
          <i aria-hidden="true">·</i>
          {onlineReady ? `${onlineCount} 人在线` : '离线'}
        </span>
      </div>

      {!puzzle || status === 'lobby' ? (
        <section className="turtle-lobby" aria-labelledby="turtle-lobby-title">
          <div className="turtle-lobby-mark" aria-hidden="true">CASE FILE</div>
          <p className="turtle-eyebrow">THE SOUP IS NOT READY</p>
          <h3 id="turtle-lobby-title">{isHost ? '卷宗在你手里' : '等主持人开汤'}</h3>
          <p className="turtle-lobby-copy">
            {isHost
              ? '你是本场主持人。选一份档案开汤，然后坐在桌子这头，用「是 / 否 / 无关 / 部分」回答大家的提问。汤底只有你看得到。'
              : onlineReady
                ? `主持人 ${hostName} 正在翻档案。开汤后，你可以在下面提问或直接猜汤底。`
                : '正在接入本场的公共频道。连上后，最早进来的人会自动成为主持人。'}
          </p>
          {isHost && (
            <>
              <button type="button" className="turtle-primary" onClick={startRandom} data-turtle-start>
                随机开一局
              </button>
              <PuzzlePicker currentId="" onPick={startRound} />
            </>
          )}
          <p className="turtle-lobby-note">
            主持人由最早进入的人自动担任；主持人离开后，下一位自动接手。开局后不能中途加入主持，只能等下一局。
          </p>
        </section>
      ) : (
        <section
          className={`turtle-case is-${puzzle.difficulty}`}
          data-turtle-case
          data-turtle-puzzle={puzzle.id}
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
            >
              {TURTLE_DIFFICULTY[puzzle.difficulty]?.label ?? '档案'}
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

      {isHost && puzzle && status === 'playing' && (
        <section className="turtle-classified" aria-label="主持人机密">
          <button
            type="button"
            className={`turtle-truth-toggle${truthOpen ? ' is-open' : ''}`}
            onClick={() => setTruthOpen((open) => !open)}
            aria-expanded={truthOpen}
            data-turtle-truth-toggle
          >
            <span>{truthOpen ? '收起汤底' : '查看汤底'}</span>
            <small>仅主持人可见</small>
          </button>
          {truthOpen && (
            <div className="turtle-truth" data-turtle-truth>
              <div className="turtle-truth-head">
                <span>CLASSIFIED · 主持人</span>
                <strong>汤底</strong>
              </div>
              <p>{puzzle.bottom}</p>
            </div>
          )}
        </section>
      )}

      {isHost && puzzle && status === 'playing' && (
        <section className="turtle-host-desk" aria-labelledby="turtle-host-desk-title">
          <div className="turtle-section-head">
            <h3 id="turtle-host-desk-title">主持人桌面</h3>
            <span>回答提问 · 判定猜测</span>
          </div>
          <div className="turtle-host-actions">
            <button type="button" className="turtle-ghost" onClick={() => setPendingAction('swap')} data-turtle-swap>
              换一题
            </button>
            <button type="button" className="turtle-danger" onClick={() => setPendingAction('reveal')} data-turtle-reveal>
              揭底结案
            </button>
          </div>
          {pendingAction && (
            <div className="turtle-confirm" role="alert" data-turtle-confirm data-turtle-confirm-action={pendingAction}>
              <p>
                {pendingAction === 'reveal'
                  ? '揭底会把汤底公开，并结束本局。后面的提问和猜测将不再计分。'
                  : '换题会丢掉本局的问答和猜测，直接开一份新档案。'}
              </p>
              <div className="turtle-confirm-actions">
                <button type="button" className="turtle-ghost" onClick={() => setPendingAction(null)} data-turtle-cancel>
                  取消
                </button>
                <button
                  type="button"
                  className={pendingAction === 'reveal' ? 'turtle-danger' : 'turtle-primary'}
                  onClick={pendingAction === 'reveal' ? revealRound : startRandom}
                  data-turtle-confirm-yes
                >
                  {actionLabel}
                </button>
              </div>
            </div>
          )}

          <div className="turtle-guess-desk">
            <div className="turtle-section-head">
              <h3>猜测判定</h3>
              <span>{pendingGuesses.length > 0 ? `${pendingGuesses.length} 条待判` : '暂无待判'}</span>
            </div>
            {guesses.length > 0 ? (
              <ul className="turtle-guess-list">
                {guesses.map((guess) => (
                  <li
                    className={`turtle-guess is-${guess.verdict}`}
                    key={guess.id}
                    data-turtle-guess
                    data-guess-verdict={guess.verdict}
                  >
                    <div className="turtle-guess-meta">
                      <strong>{guess.name}</strong>
                      <span>{formatClock(guess.at)}</span>
                    </div>
                    <p className="turtle-guess-text">{guess.text}</p>
                    {guess.verdict === 'pending' ? (
                      <div className="turtle-judge-actions">
                        <button type="button" className="turtle-ghost" onClick={() => judgeGuess(guess.id, false)} data-turtle-judge="wrong">
                          还不对
                        </button>
                        <button type="button" className="turtle-primary" onClick={() => judgeGuess(guess.id, true)} data-turtle-judge="correct">
                          算猜中，结案
                        </button>
                      </div>
                    ) : (
                      <span className={`turtle-guess-state is-${guess.verdict}`}>
                        {guess.verdict === 'correct' ? '判定：猜中' : '判定：不对'}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="turtle-empty">还没有人猜汤底。等他们问累了，就会有人试着把真相拼起来。</p>
            )}
          </div>
        </section>
      )}

      {!isHost && puzzle && status === 'playing' && (
        <section className="turtle-player-desk" aria-label="提问和猜汤底">
          <form className="turtle-form" onSubmit={submitQuestion} data-turtle-question-form>
            <label htmlFor="turtle-question-input">
              <span className="turtle-form-label">提一个问题</span>
              <small>只能用「是 / 否 / 无关 / 部分」来回答</small>
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
                disabled={!canAsk}
                data-turtle-question-input
              />
              <button type="submit" className="turtle-primary" disabled={!canAsk || !questionDraft.trim()} data-turtle-question-send>
                提问
              </button>
            </div>
          </form>

          <form className="turtle-form turtle-guess-form" onSubmit={submitGuess} data-turtle-guess-form>
            <label htmlFor="turtle-guess-input">
              <span className="turtle-form-label">直接猜汤底</span>
              <small>把完整真相写出来，由主持人判定</small>
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
                disabled={!canGuess}
                data-turtle-guess-input
              />
              <button type="submit" className="turtle-danger" disabled={!canGuess || !guessDraft.trim()} data-turtle-guess-send>
                提交猜测
              </button>
            </div>
          </form>

          {ownGuesses.length > 0 && (
            <div className="turtle-own-guesses">
              <p className="turtle-own-guesses-title">你的猜测</p>
              {ownGuesses.map((guess) => (
                <p className="turtle-own-guess" key={guess.id} data-turtle-own-guess={guess.verdict}>
                  <span>“{guess.text}”</span>
                  <strong>
                    {guess.verdict === 'correct' ? '猜中' : guess.verdict === 'wrong' ? '不对' : '等主持人判定'}
                  </strong>
                </p>
              ))}
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
              {isHost ? '还没有人提问。把汤面念一遍，等第一句问题。' : '第一句问题还没有出现。问得越具体，汤底越近。'}
            </p>
          ) : (
            <ol className="turtle-question-list">
              {questions.map((question, index) => (
                <li
                  key={question.id}
                  className={`turtle-question${question.verdict ? ' is-answered' : ''}`}
                  data-turtle-question
                  data-turtle-question-id={question.id}
                  data-question-verdict={question.verdict || 'pending'}
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
                    {isHost && status === 'playing' ? (
                      <div className="turtle-verdict-actions" role="group" aria-label="回答这个问题">
                        {VERDICTS.map((verdict) => (
                          <button
                            key={verdict.id}
                            type="button"
                            className={`turtle-verdict-btn is-${verdict.id}${question.verdict === verdict.id ? ' is-active' : ''}`}
                            onClick={() => answerQuestion(question.id, verdict.id)}
                            title={verdict.hint}
                            aria-pressed={question.verdict === verdict.id}
                            data-turtle-verdict={verdict.id}
                          >
                            {verdict.label}
                          </button>
                        ))}
                      </div>
                    ) : question.verdict ? (
                      <VerdictChip verdict={question.verdict} />
                    ) : (
                      <span className="turtle-verdict-wait">待主持人</span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
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
            {room?.endReason === 'guessed' ? 'GUESSED · 猜中' : 'REVEALED · 揭底'}
          </p>
          <h3 id="turtle-reveal-title">
            {room?.endReason === 'guessed' ? '有人猜中了汤底' : '主持人揭开了汤底'}
          </h3>
          {room?.endReason === 'guessed' && room?.winnerName && (
            <p className="turtle-winner">
              猜中者：<strong>{room.winnerName}</strong>
              {room.winnerPid && room.winnerPid === playerId ? '（你）' : ''}
              {room.winningGuess ? <span>“{room.winningGuess}”</span> : null}
            </p>
          )}
          <div className="turtle-truth is-public" data-turtle-truth>
            <div className="turtle-truth-head">
              <span>CASE CLOSED</span>
              <strong>{puzzle.title} · 汤底</strong>
            </div>
            <p>{puzzle.bottom}</p>
          </div>
          {isHost ? (
            <div className="turtle-reveal-actions">
              <button type="button" className="turtle-primary" onClick={startRandom} data-turtle-next>
                下一题
              </button>
              <PuzzlePicker currentId={puzzle.id} onPick={startRound} compact />
            </div>
          ) : (
            <p className="turtle-reveal-wait">等主持人开下一题。你也可以先翻翻下面自己的问答记录。</p>
          )}
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
                      {player.sid === hostCandidate?.sid ? '主持人' : '在席'}
                      <i aria-hidden="true">·</i>
                      {player.score} 分
                    </small>
                  </span>
                  {player.sid === hostCandidate?.sid && (
                    <span className="turtle-crown" aria-label="主持人">♛</span>
                  )}
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
            <span><small>提问</small><strong>{stats.questions}</strong></span>
            <span><small>主持</small><strong>{stats.hosted}</strong></span>
          </div>
          <p className="turtle-score-note">猜中汤底 +10，被回答的提问 +1，主持结案 +3。</p>
        </section>
      </div>

      <details className="turtle-howto">
        <summary>怎么玩 · 海龟汤规则</summary>
        <ol>
          <li>主持人先看汤底，其他玩家只看汤面。</li>
          <li>玩家只能问能用「是 / 否 / 无关 / 部分」回答的问题，主持人逐条判定。</li>
          <li>玩家可以随时提交完整猜测；主持人判定猜中即结案。主持人也可以直接揭底。</li>
          <li>本局内容通过 Supabase Realtime 公共频道同步。不建表、不写库、不广播账号 id。</li>
          <li>公共频道里提问和猜测对订阅者可见，别放真实隐私。主持人角色是客户端约定，不是权限边界。</li>
        </ol>
      </details>

      <p className="turtle-foot">
        十份原创档案收在 <code>src/lab/turtleData.js</code>。换账号不会串积分；清空浏览器存储会重新开始。
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
