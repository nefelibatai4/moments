import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'

/**
 * 当前用户未读私聊总数（导航栏角标用）。
 *
 * 用"重新计数"而不是本地加减：标记已读可能一次影响多行（进入会话页会把
 * 该会话全部未读置为已读），本地加减容易算错。数据量很小，重算更可靠。
 * 加 300ms 防抖，避免连续消息触发一串查询。
 */
export function useUnreadCount(userId) {
  const [rawCount, setRawCount] = useState(0)

  // 未登录直接算 0，避免在 effect 里同步 setState（会多触发一轮渲染）
  const count = userId ? rawCount : 0

  useEffect(() => {
    if (!userId) return

    let cancelled = false
    let timer = null

    async function refresh() {
      const { count: n, error } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_id', userId)
        .is('read_at', null)

      if (!cancelled && !error) setRawCount(n ?? 0)
    }

    function scheduleRefresh() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(refresh, 300)
    }

    refresh()

    const channel = supabase
      .channel(`unread-${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        if (payload.new?.recipient_id === userId) scheduleRefresh()
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new
        // 收到方标记已读、或自己发出消息，都会影响未读数
        if (m && (m.recipient_id === userId || m.sender_id === userId)) scheduleRefresh()
      })
      .subscribe()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  }, [userId])

  return count
}
