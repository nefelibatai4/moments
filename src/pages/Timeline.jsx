import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import MomentCard from '../components/MomentCard'

export default function Timeline() {
  const [moments, setMoments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('moments')
        .select('*, likes(visitor_id), comments(*)')
        .order('created_at', { ascending: false })

      if (error) {
        setError(error.message)
      } else {
        setMoments(data)
      }
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return <p className="status-text">加载中…</p>
  if (error) return <p className="status-text">加载失败：{error}</p>
  if (moments.length === 0) return <p className="status-text">还没有动态。</p>

  function handleDeleted(id) {
    setMoments((prev) => prev.filter((m) => m.id !== id))
  }

  return (
    <div className="timeline">
      {moments.map((m) => (
        <MomentCard key={m.id} moment={m} onDeleted={handleDeleted} />
      ))}
    </div>
  )
}
