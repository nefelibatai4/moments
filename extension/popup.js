// popup 的逻辑很薄：只负责把 background 的状态显示出来，外加一个手动刷新按钮。
// 真正的数据都在 background 里（它是唯一持有会话的地方，避免两处各自刷新 token 打架）。

const dot = document.getElementById('dot')
const statusText = document.getElementById('statusText')
const refreshBtn = document.getElementById('refreshBtn')

function timeLabel(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function render(status) {
  if (!status) {
    dot.className = 'dot'
    statusText.textContent = '尚未检查'
    return
  }

  if (status.hasSession && status.lastError) {
    dot.className = 'dot warn'
    statusText.textContent = `同步异常：${status.lastError}`
    return
  }

  if (!status.hasSession) {
    // 会话是网页那边同步过来的，所以先要在网页里登录一次
    dot.className = 'dot warn'
    statusText.textContent = '未同步会话 · 在下方登录一次即可'
    return
  }

  const n = status.unread || 0
  const t = timeLabel(status.lastChecked)
  dot.className = 'dot ok'
  statusText.textContent = n > 0 ? `${n} 条未读私信${t ? ` · ${t} 检查` : ''}` : `无未读${t ? ` · ${t} 检查` : ''}`
}

async function load() {
  try {
    render(await chrome.runtime.sendMessage({ type: 'status:get' }))
  } catch {
    dot.className = 'dot warn'
    statusText.textContent = '无法连接后台，试试重新加载扩展'
  }
}

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true
  statusText.textContent = '刷新中…'
  try {
    await chrome.runtime.sendMessage({ type: 'refresh' })
  } catch {
    /* 后台暂时不可用，下面 load() 会把状态显示出来 */
  }
  await load()
  refreshBtn.disabled = false
})

// background 每次轮询都会更新 status，这里跟着刷，面板开着时数字是活的
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.status) render(changes.status.newValue)
})

load()
