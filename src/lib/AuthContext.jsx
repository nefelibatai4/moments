import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'

// session:   undefined = 还在加载 / null = 未登录 / object = 已登录
// approved:  undefined = 还在查询 / null = 未登录 / false = 已登录但未激活 / true = 已激活
const AuthContext = createContext({
  session: undefined,
  approved: undefined,
  refreshApproval: () => {},
})

// ── 激活状态的本地缓存 ────────────────────────────────────────────
// 为什么缓存：冷启动时"先查 approved 才渲染时间线"是一次**串行**网络往返，
// 是首屏最主要的等待来源。缓存后再次打开可以先渲染、再后台校验。
//
// ⚠️ 安全说明：这个缓存**只影响界面，不影响权限**。
// 真正的门禁在数据库——所有读取策略都要求 is_approved()。
// 即使用户手工把缓存改成 true，也只会看到一个空时间线，拿不到任何数据。
const APPROVED_CACHE_KEY = 'moments_approved'

// 激活状态查询的重试：第 N 次前等 N * 400ms，三次合计约 1.2 秒。
// 这个查询只决定"渲染哪个界面"，但一次抖动就误判成"未激活"的代价很大（见 #47）。
const APPROVAL_ATTEMPTS = 3
const APPROVAL_RETRY_DELAY_MS = 400

// ⚠️ 缓存只表示「**确实已激活**」这一种事实，刻意**不缓存 false**。
//
// 为什么（2026-09-21 线上事故）：旧实现把 false 也写进缓存，而当时
// 「查询失败」被当成「未激活」—— 于是**一次网络抖动就把已激活账号的缓存写成了 false**，
// 之后每次打开都先按缓存把人弹到 /activate 要邀请码，
// 刷新几次、等某次查询碰巧成功才恢复。详见 docs/PITFALLS.md #47。
function readCachedApproval(userId) {
  try {
    const parsed = JSON.parse(localStorage.getItem(APPROVED_CACHE_KEY) || 'null')
    // 只有 approved === true 才算命中。旧版本写下的 { approved: false } 一律当"没有缓存"，
    // 这样历史上被污染的缓存会**自愈**，不需要用户手动清 localStorage。
    if (parsed?.userId !== userId || parsed.approved !== true) return undefined
    return true
  } catch {
    return undefined
  }
}

function writeCachedApproval(userId, approved) {
  try {
    if (approved) {
      localStorage.setItem(APPROVED_CACHE_KEY, JSON.stringify({ userId, approved: true }))
    } else {
      // 没激活就不留缓存（而不是留一条 false）
      localStorage.removeItem(APPROVED_CACHE_KEY)
    }
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略 */
  }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined)
  const [approved, setApproved] = useState(undefined)
  const lastUserIdRef = useRef(undefined)
  // 请求序号：只让"最新那次"查询的结果生效，避免先发出的旧请求（例如刚注册、
  // 邀请码还没认领时读到 approved=false）后返回、把新结果覆盖掉。
  const seqRef = useRef(0)

  const loadApproval = useCallback(async (userId) => {
    const seq = ++seqRef.current
    let lastError = null

    for (let attempt = 0; attempt < APPROVAL_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, APPROVAL_RETRY_DELAY_MS * attempt))
      if (seq !== seqRef.current) return // 已有更新的请求，丢弃这次结果

      // ⚠️ 用 maybeSingle 而不是 single，这样能区分下面两种"没拿到答案"：
      //   single()      0 行和请求失败**都是 error**，被混成一种；
      //   maybeSingle() 0 行是 { data: null, error: null }，只有真失败才 error。
      //
      // ⚠️⚠️ 但**两种都必须重试，都不能据此判定"未激活"**：
      //   ① error        —— 请求本身失败（网络 / HTTP）；
      //   ② data === null —— 200 但 0 行。对已登录用户这必然是异常：
      //      auth.users 上有 `on_auth_user_created` 触发器，每个用户必然配一行 profile，
      //      而且 RLS 允许读自己那一行。所以 0 行只可能是 **access token 还没就绪 / RLS 竞态**。
      //      这**正是本次线上事故的真实触发路径**：PostgREST 返回 200 + 空数组，
      //      旧代码用 single() 拿到 PGRST116，然后写成 approved=false 并污染缓存，
      //      于是已激活账号被弹到 /activate 要邀请码。
      const { data, error } = await supabase
        .from('profiles')
        .select('approved')
        .eq('id', userId)
        .maybeSingle()

      if (seq !== seqRef.current) return

      if (error || data === null) {
        lastError = error ?? new Error('profiles 查询返回 0 行（token 可能还没就绪）')
        continue
      }

      const ok = !!data.approved
      setApproved(ok)
      writeCachedApproval(userId, ok)
      return
    }

    if (seq !== seqRef.current) return
    // 重试全失败：**绝不能据此判定"未激活"**（那正是这次的事故），
    // 保留上一次的结论即可 —— 调用前已经用缓存填过一次；
    // 若确实什么都还没有，RequireAuth 的兜底定时器会继续重试。
    console.error(`[auth] 读取激活状态失败（已重试 ${APPROVAL_ATTEMPTS} 次）：`, lastError?.message)
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => listener.subscription.unsubscribe()
  }, [])

  // 只在 user id 真正变化时重新查询，避免 token 刷新触发多余请求
  useEffect(() => {
    if (session === undefined) return
    const uid = session?.user?.id ?? null
    if (uid === lastUserIdRef.current) return
    lastUserIdRef.current = uid

    if (!uid) {
      setApproved(null)
      return
    }

    // 先用缓存立即渲染（命中时 RequireAuth 不再显示"加载中…"），
    // 再后台校验并写回缓存 —— 典型的 stale-while-revalidate。
    // 没缓存时 cached 是 undefined，行为与改造前完全一致。
    setApproved(readCachedApproval(uid))
    loadApproval(uid)
  }, [session, loadApproval])

  // 认领邀请码成功后手动刷新激活状态。
  // 这里直接从 supabase 现取 session，而不是用闭包里的 session：
  // 注册流程里 signUp 刚返回时，Context 的 session 可能还没更新，用闭包值会拿到 undefined
  // 导致刷新被跳过，用户就会被 RequireAuth 误判为未激活而弹回 /activate。
  const refreshApproval = useCallback(async () => {
    const { data } = await supabase.auth.getSession()
    const uid = data.session?.user?.id
    if (uid) {
      lastUserIdRef.current = uid
      await loadApproval(uid)
    }
  }, [loadApproval])

  return (
    <AuthContext.Provider value={{ session, approved, refreshApproval }}>
      {children}
    </AuthContext.Provider>
  )
}

// 兼容旧用法：只取 session
export function useAuth() {
  return useContext(AuthContext).session
}

// 需要激活状态时用这个
export function useAccess() {
  return useContext(AuthContext)
}
