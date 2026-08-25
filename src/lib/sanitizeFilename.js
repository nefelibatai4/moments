export function safeStorageKey(userId, originalName) {
  const match = originalName.match(/\.[a-zA-Z0-9]{1,5}$/)
  const ext = match ? match[0].toLowerCase() : ''
  const random = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${userId}/${Date.now()}-${random}${ext}`
}
