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

function readCachedApproval(userId) {
  try {
    const parsed = JSON.parse(localStorage.getItem(APPROVED_CACHE_KEY) || 'null')
    return parsed?.userId === userId ? !!parsed.approved : undefined
  } catch {
    return undefined
  }
}

function writeCachedApproval(userId, approved) {
  try {
    localStorage.setItem(APPROVED_CACHE_KEY, JSON.stringify({ userId, approved }))
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
    // 未激活账号只能读到自己那一行（profiles_auth_read 的 auth.uid() = id 分支），
    // 所以这个查询对未激活账号也是通的。
    const { data, error } = await supabase
      .from('profiles')
      .select('approved')
      .eq('id', userId)
      .single()

    if (seq !== seqRef.current) return // 已有更新的请求，丢弃这次结果

    if (error) {
      console.error('[auth] 读取激活状态失败:', error.message)
      setApproved(false)
      writeCachedApproval(userId, false)
    } else {
      const ok = !!data.approved
      setApproved(ok)
      writeCachedApproval(userId, ok)
    }
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
