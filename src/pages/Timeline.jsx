import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import MomentCard from '../components/MomentCard'
import MomentSkeleton from '../components/MomentSkeleton'

const MOMENT_SELECT =
  '*, profiles!moments_user_id_fkey(nickname, avatar_url), likes(user_id, profiles(nickname)), comments(*, profiles(nickname, avatar_url), comment_likes(user_id))'

const PAGE_SIZE = 15

export default function Timeline() {
  const [moments, setMoments] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState(null)
  // 用回调 ref 而不是 useRef：首屏渲染的是"加载中…"，哨兵元素还没进 DOM，
  // 用 useRef + [] 依赖的 effect 会在挂载时拿到 null，观察器就永远不生效了。
  const [sentinelEl, setSentinelEl] = useState(null)

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
      const { data, error: loadError } = await supabase
        .from('moments')
        .select(MOMENT_SELECT)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE)

      if (cancelled) return
      if (loadError) {
        setError(loadError.message)
      } else {
        setMoments(data ?? [])
        setHasMore((data?.length ?? 0) === PAGE_SIZE)
      }
      setLoading(false)
    }
    load()

    // 只刷新受影响的那一条（评论/点赞变化时用）
    async function patchMoment(id) {
      const fresh = await fetchMoment(id)
      if (cancelled || !fresh) return
      setMoments((prev) => prev.map((m) => (m.id === id ? fresh : m)))
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
        setMoments((prev) => (prev.some((m) => m.id === fresh.id) ? prev : [fresh, ...prev]))
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'moments' }, async (payload) => {
        const fresh = await fetchMoment(payload.new.id)
        if (cancelled || !fresh) return
        setMoments((prev) => prev.map((m) => (m.id === fresh.id ? fresh : m)))
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'moments' }, (payload) => {
        const id = payload.old?.id
        if (id) setMoments((prev) => prev.filter((m) => m.id !== id))
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments' }, (payload) => {
        if (payload.new?.moment_id) patchMoment(payload.new.moment_id)
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'comments' }, (payload) => {
        if (payload.old?.moment_id) patchMoment(payload.old.moment_id)
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
  }, [fetchMoment])

  // 用 created_at 游标翻页，而不是 offset：
  // 翻页过程中别人发了新动态时，offset 会漏读或重复，游标不会。
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    const oldest = moments[moments.length - 1]?.created_at
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
      setMoments((prev) => {
        const seen = new Set(prev.map((m) => m.id))
        return [...prev, ...(data ?? []).filter((m) => !seen.has(m.id))]
      })
      setHasMore((data?.length ?? 0) === PAGE_SIZE)
    }
    setLoadingMore(false)
  }, [moments, loadingMore, hasMore])

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
    setMoments((prev) => prev.filter((m) => m.id !== id))
  }

  // 评论 / 点赞是卡片里的本地即时反馈（乐观更新），
  // 数据源统一放在这里，实时订阅拿到新数据后也写同一个地方。
  const handleCommentAdded = useCallback((momentId, comment) => {
    setMoments((prev) =>
      prev.map((m) => (m.id === momentId ? { ...m, comments: [...(m.comments ?? []), comment] } : m))
    )
  }, [])

  const handleLikesChanged = useCallback((momentId, likes) => {
    setMoments((prev) => prev.map((m) => (m.id === momentId ? { ...m, likes } : m)))
  }, [])

  const handleCommentDeleted = useCallback((momentId, commentId) => {
    setMoments((prev) =>
      prev.map((m) =>
        // 删掉评论本身，同时把它下面的回复一起移除
        // （数据库是级联删除，本地状态也要跟上，否则会留下孤儿回复）
        m.id === momentId
          ? { ...m, comments: (m.comments ?? []).filter((c) => c.id !== commentId && c.parent_id !== commentId) }
          : m
      )
    )
  }, [])

  // 评论点赞：把某条评论的点赞数组换掉
  const handleCommentLikeChanged = useCallback((momentId, commentId, likes) => {
    setMoments((prev) =>
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
    setMoments((prev) => prev.map((m) => (m.id === momentId ? { ...m, ...fields } : m)))
  }, [])

  if (loading) return <MomentSkeleton count={3} />
  if (error) return <p className="status-text">加载失败：{error}</p>
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
          onCommentLikeChanged={handleCommentLikeChanged}
          onLikesChanged={handleLikesChanged}
          onMomentUpdated={handleMomentUpdated}
        />
      ))}
      <div ref={setSentinelEl} className="timeline-sentinel" />
      {loadingMore && <p className="status-text">加载更多…</p>}
      {!hasMore && <p className="status-text timeline-end">没有更多了</p>}
    </div>
  )
}
