import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../lib/AuthContext'
import { readTimelineSnapshot, writeTimelineSnapshot } from '../lib/timelineSnapshot'
import { decryptTimelineRows, onUnlockChange, unlockStateVersion } from '../lib/crypto'
import { sweepCirclePlaintext, sweepMyMessages } from '../lib/circleSync'
import { sweepImagePlaintext } from '../lib/imageSync'
import MomentCard from '../components/MomentCard'
import MomentSkeleton from '../components/MomentSkeleton'

const MOMENT_SELECT =
  '*, profiles!moments_user_id_fkey(nickname, avatar_url), likes(user_id, profiles(nickname)), comments(*, profiles(nickname, avatar_url), comment_likes(user_id))'

const PAGE_SIZE = 15

export default function Timeline() {
  const session = useAuth()
  const userId = session?.user?.id
  // ⚠️ 两层：`rawMoments` 是库里那一行（可能是密文），`moments` 是解密后给界面用的。
  //    所有取数/实时补丁/写操作都只碰 raw，明文由下面那个 effect 统一解出来。
  const [rawMoments, setRawMoments] = useState([])
  const [moments, setMoments] = useState([])
  const [unlockV, setUnlockV] = useState(() => unlockStateVersion())
  useEffect(() => onUnlockChange(setUnlockV), [])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState(null)
  // 用回调 ref 而不是 useRef：首屏渲染的是"加载中…"，哨兵元素还没进 DOM，
  // 用 useRef + [] 依赖的 effect 会在挂载时拿到 null，观察器就永远不生效了。
  const [sentinelEl, setSentinelEl] = useState(null)

  // 先用上次的快照把内容画出来（见 lib/timelineSnapshot.js）。
  // ⚠️ 必须用 useLayoutEffect 而不是 useEffect：后者在**浏览器画完第一帧之后**才跑，
  //    用户会先看到骨架屏闪一下再看到内容 —— 那就白做了。layout effect 在绘制前跑，
  //    这里 setState 出去的内容会直接进第一帧。
  useLayoutEffect(() => {
    if (!userId) return
    const cached = readTimelineSnapshot(userId)
    if (!cached) return
    setRawMoments((prev) => (prev.length > 0 ? prev : cached))
    setLoading(false)
  }, [userId])

  // 取单条动态的完整嵌套数据（实时事件只带原始行，没有 join 出来的昵称/头像）
  const fetchMoment = useCallback(async (id) => {
    const { data, error: fetchError } = await supabase
      .from('moments')
      .select(MOMENT_SELECT)
      .eq('id', id)
      .single()
    return fetchError ? null : data
  }, [])

  useEffect(() => {
    let cancelled = false

    async function load() {
      // ⚠️ 必须 try/catch：网络被拦断时 supabase-js 有可能是**抛异常**而不是
      //    返回 { error }（实测：把 /rest/v1/moments 直接 abort 掉时，
      //    不 catch 的话这里静默失败 —— 界面留着快照内容、却什么提示都没有）。
      try {
        const { data, error: loadError } = await supabase
          .from('moments')
          .select(MOMENT_SELECT)
          .order('created_at', { ascending: false })
          .limit(PAGE_SIZE)

        if (cancelled) return
        if (loadError) {
          // 有快照内容时不整屏报错（内容还在，用户至少能看）——错误挪到列表末尾一行
          setError(loadError.message)
        } else {
          setRawMoments(data ?? [])
          setHasMore((data?.length ?? 0) === PAGE_SIZE)
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || '网络请求失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()

    // 只刷新受影响的那一条（评论/点赞变化时用）
    async function patchMoment(id) {
      const fresh = await fetchMoment(id)
      if (cancelled || !fresh) return
      setRawMoments((prev) => prev.map((m) => (m.id === id ? fresh : m)))
    }

    // 评论点赞的实时事件只带 comment_id，不带 moment_id，
    // 所以先查出它属于哪条动态，再刷新那一条。
    async function patchMomentByComment(commentId) {
      const { data, error: lookupError } = await supabase
        .from('comments')
        .select('moment_id')
        .eq('id', commentId)
        .single()
      if (cancelled || lookupError || !data) return
      await patchMoment(data.moment_id)
    }

    // 频道名带随机后缀：StrictMode 下会挂载两次，避免同名频道互相干扰
    const channel = supabase
      .channel(`timeline-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'moments' }, async (payload) => {
        const fresh = await fetchMoment(payload.new.id)
        if (cancelled || !fresh) return
        setRawMoments((prev) => (prev.some((m) => m.id === fresh.id) ? prev : [fresh, ...prev]))
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'moments' }, async (payload) => {
        const fresh = await fetchMoment(payload.new.id)
        if (cancelled || !fresh) return
        setRawMoments((prev) => prev.map((m) => (m.id === fresh.id ? fresh : m)))
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'moments' }, (payload) => {
        const id = payload.old?.id
        if (id) setRawMoments((prev) => prev.filter((m) => m.id !== id))
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments' }, (payload) => {
        if (payload.new?.moment_id) patchMoment(payload.new.moment_id)
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'comments' }, (payload) => {
        if (payload.old?.moment_id) patchMoment(payload.old.moment_id)
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'comments' }, (payload) => {
        // 评论编辑（content / edited_at 变化）。comments 是 REPLICA IDENTITY FULL，新行完整
        if (payload.new?.moment_id) patchMoment(payload.new.moment_id)
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'likes' }, (payload) => {
        if (payload.new?.moment_id) patchMoment(payload.new.moment_id)
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'likes' }, (payload) => {
        if (payload.old?.moment_id) patchMoment(payload.old.moment_id)
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comment_likes' }, (payload) => {
        if (payload.new?.comment_id) patchMomentByComment(payload.new.comment_id)
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'comment_likes' }, (payload) => {
        if (payload.old?.comment_id) patchMomentByComment(payload.old.comment_id)
      })
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [fetchMoment, userId])

  // 库里那一行 → 界面用的明文（动态正文 + 嵌套的评论，评论与动态共用同一条 CEK）。
  // 密钥是"晚一点才进内存"的（登录解锁 / 设备缓存解锁），所以订阅 unlockV：解锁后自动重解。
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const out = await decryptTimelineRows(rawMoments)
      if (cancelled) return
      setMoments(out)
      // 快照写**解密后**的内容：下次打开第一帧就是正文，而不是先闪一下"读不到"。
      // （与私聊的会话缓存同一取舍：明文落本地，防的是云、不防"拿到你解锁设备的人"。）
      if (userId) writeTimelineSnapshot(userId, out)
    })()
    return () => { cancelled = true }
  }, [rawMoments, unlockV, userId])

  // 后台把**自己发的历史明文**动态/评论补加密（静默、幂等、每次会话最多几十条）。
  // 加密用的私钥只在这台设备上，所以服务端做不了这件事 —— 只能等发布者打开应用。
  useEffect(() => {
    if (!userId) return undefined
    // 先补文字的（要给动态生成 CEK），再补图片（图片的钥匙就是那条 CEK）—— 所以图片晚一点起
    const t1 = setTimeout(() => { sweepCirclePlaintext(userId) }, 1500)
    const t2 = setTimeout(() => { sweepImagePlaintext(userId) }, 6000)
    // 历史私聊也在这里补：不要求使用者点进那段对话（否则一年不点就一年是明文）
    const t3 = setTimeout(() => { sweepMyMessages(userId) }, 9000)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [userId])

  // 用 created_at 游标翻页，而不是 offset：
  // 翻页过程中别人发了新动态时，offset 会漏读或重复，游标不会。
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    const oldest = rawMoments[rawMoments.length - 1]?.created_at
    if (!oldest) return

    setLoadingMore(true)
    const { data, error: moreError } = await supabase
      .from('moments')
      .select(MOMENT_SELECT)
      .order('created_at', { ascending: false })
      .lt('created_at', oldest)
      .limit(PAGE_SIZE)

    if (moreError) {
      setError(moreError.message)
    } else {
      setRawMoments((prev) => {
        const seen = new Set(prev.map((m) => m.id))
        return [...prev, ...(data ?? []).filter((m) => !seen.has(m.id))]
      })
      setHasMore((data?.length ?? 0) === PAGE_SIZE)
    }
    setLoadingMore(false)
  }, [rawMoments, loadingMore, hasMore])

  // 观察器只挂一次，通过 ref 取到最新的 loadMore，避免频繁重建观察器
  const loadMoreRef = useRef(loadMore)
  useEffect(() => {
    loadMoreRef.current = loadMore
  }, [loadMore])

  useEffect(() => {
    if (!sentinelEl || typeof IntersectionObserver !== 'function') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreRef.current()
      },
      { rootMargin: '300px' }
    )
    observer.observe(sentinelEl)
    return () => observer.disconnect()
  }, [sentinelEl])

  function handleDeleted(id) {
    setRawMoments((prev) => prev.filter((m) => m.id !== id))
  }

  // 评论 / 点赞是卡片里的本地即时反馈（乐观更新），
  // 数据源统一放在这里，实时订阅拿到新数据后也写同一个地方。
  const handleCommentAdded = useCallback((momentId, comment) => {
    setRawMoments((prev) =>
      prev.map((m) => (m.id === momentId ? { ...m, comments: [...(m.comments ?? []), comment] } : m))
    )
  }, [])

  const handleLikesChanged = useCallback((momentId, likes) => {
    setRawMoments((prev) => prev.map((m) => (m.id === momentId ? { ...m, likes } : m)))
  }, [])

  const handleCommentDeleted = useCallback((momentId, commentId) => {
    setRawMoments((prev) =>
      prev.map((m) =>
        // 删掉评论本身，同时把它下面的回复一起移除
        // （数据库是级联删除，本地状态也要跟上，否则会留下孤儿回复）
        m.id === momentId
          ? { ...m, comments: (m.comments ?? []).filter((c) => c.id !== commentId && c.parent_id !== commentId) }
          : m
      )
    )
  }, [])

  // 评论编辑：只更新对应行的内容与 edited_at，其余（点赞等嵌套数据）保留
  const handleCommentUpdated = useCallback((momentId, commentId, fields) => {
    setRawMoments((prev) =>
      prev.map((m) =>
        m.id === momentId
          ? {
              ...m,
              comments: (m.comments ?? []).map((c) =>
                c.id === commentId ? { ...c, ...fields } : c
              ),
            }
          : m
      )
    )
  }, [])

  // 评论点赞：把某条评论的点赞数组换掉
  const handleCommentLikeChanged = useCallback((momentId, commentId, likes) => {
    setRawMoments((prev) =>
      prev.map((m) =>
        m.id === momentId
          ? {
              ...m,
              comments: (m.comments ?? []).map((c) =>
                c.id === commentId ? { ...c, comment_likes: likes } : c
              ),
            }
          : m
      )
    )
  }, [])

  const handleMomentUpdated = useCallback((momentId, fields) => {
    setRawMoments((prev) => prev.map((m) => (m.id === momentId ? { ...m, ...fields } : m)))
  }, [])

  if (loading) return <MomentSkeleton count={3} />
  // 一条都没有 + 出错 → 整屏报错；有内容（来自快照或已加载）→ 错误只占末尾一行
  if (error && moments.length === 0) return <p className="status-text">加载失败：{error}</p>
  if (moments.length === 0) return <p className="status-text">还没有动态。</p>

  return (
    <div className="timeline">
      {moments.map((m) => (
        <MomentCard
          key={m.id}
          moment={m}
          onDeleted={handleDeleted}
          onCommentAdded={handleCommentAdded}
          onCommentDeleted={handleCommentDeleted}
          onCommentUpdated={handleCommentUpdated}
          onCommentLikeChanged={handleCommentLikeChanged}
          onLikesChanged={handleLikesChanged}
          onMomentUpdated={handleMomentUpdated}
        />
      ))}
      <div ref={setSentinelEl} className="timeline-sentinel" />
      {loadingMore && <p className="status-text">加载更多…</p>}
      {error && <p className="status-text">刷新失败：{error}</p>}
      {!hasMore && <p className="status-text timeline-end">没有更多了</p>}
    </div>
  )
}
