import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import MomentCard from '../components/MomentCard'

const MOMENT_SELECT =
  '*, profiles!moments_user_id_fkey(nickname, avatar_url), likes(user_id, profiles(nickname)), comments(*, profiles(nickname, avatar_url))'

export default function Timeline() {
  const [moments, setMoments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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

      if (cancelled) return
      if (loadError) setError(loadError.message)
      else setMoments(data)
      setLoading(false)
    }
    load()

    // 只刷新受影响的那一条（评论/点赞变化时用）
    async function patchMoment(id) {
      const fresh = await fetchMoment(id)
      if (cancelled || !fresh) return
      setMoments((prev) => prev.map((m) => (m.id === id ? fresh : m)))
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
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [fetchMoment])

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
        m.id === momentId ? { ...m, comments: (m.comments ?? []).filter((c) => c.id !== commentId) } : m
      )
    )
  }, [])

  const handleMomentUpdated = useCallback((momentId, fields) => {
    setMoments((prev) => prev.map((m) => (m.id === momentId ? { ...m, ...fields } : m)))
  }, [])

  if (loading) return <p className="status-text">加载中…</p>
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
          onLikesChanged={handleLikesChanged}
          onMomentUpdated={handleMomentUpdated}
        />
      ))}
    </div>
  )
}
