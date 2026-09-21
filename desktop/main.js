// Moments 桌宠外壳（Electron / macOS）
//
// 设计要点（改之前先读）：
//   1. 毛玻璃必须走原生 vibrancy。CSS 的 backdrop-filter 只能模糊「页面之内」的内容，
//      糊不了桌面和壁纸 —— 这条是最容易走弯路的地方，见 shell.css 顶部注释。
//   2. 外壳不改动 Moments 网页本身，只通过 insertCSS 注入 shell.css。
//      好处：网页发版与外壳解耦，外壳改样式不需要重新部署网页。
//   3. 窗口没有标题栏，拖拽靠注入的 -webkit-app-region: drag（挂在现有导航栏上），
//      另外开启 setMovableByWindowBackground，做到「随便哪个空白处都能拖」。
const { app, BrowserWindow, globalShortcut, Menu, shell, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// 开发时用 MOMENTS_URL=http://localhost:5173/moments/chat npm start
const APP_URL = process.env.MOMENTS_URL || 'https://nefelibatai4.github.io/moments/chat'

const NORMAL_SIZE = { width: 420, height: 660 }
const COMPACT_SIZE = { width: 320, height: 420 }
const MIN_SIZE = { width: 280, height: 320 }

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json')

let win = null
let compact = false
let saveTimer = null

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
  } catch {
    return null
  }
}

function writeState() {
  if (!win || win.isDestroyed()) return
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getBounds(), compact }))
  } catch {
    // 存不下窗口位置不该影响使用，静默忽略
  }
}

// 把窗口约束在当前显示器的工作区内。
// 必要性：拔掉外接屏或换分辨率后，上次记住的坐标可能落在屏幕外，窗口就「不见了」。
function resolveBounds(saved) {
  const hasPos = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
  const area = hasPos
    ? screen.getDisplayMatching(saved).workArea
    : screen.getPrimaryDisplay().workArea

  const width = Math.min(saved?.width || NORMAL_SIZE.width, area.width)
  const height = Math.min(saved?.height || NORMAL_SIZE.height, area.height)
  const x = hasPos
    ? Math.min(Math.max(saved.x, area.x), area.x + area.width - width)
    : Math.round(area.x + (area.width - width) / 2)
  const y = hasPos
    ? Math.min(Math.max(saved.y, area.y), area.y + area.height - height)
    : Math.round(area.y + (area.height - height) / 2)

  return { width, height, x, y }
}

// 把外壳状态同步成 html 上的类名，样式全部由 shell.css 负责。
// 网页是 SPA，站内路由切换不会重新加载文档，所以这里只切状态类；
// is-desktop-shell 由 bootShell() 在文档就绪时挂上（且只需挂一次）。
function syncShellClasses() {
  if (!win || win.isDestroyed()) return
  const idle = !win.isFocused()
  win.webContents
    .executeJavaScript(
      `document.documentElement.classList.toggle('is-idle', ${idle});
       document.documentElement.classList.toggle('is-compact', ${compact});
       true;`
    )
    .catch(() => {
      // 页面还没就绪时会失败，下一次事件会补上
    })
}

// shell.css 里所有规则都作用在 html.is-desktop-shell 之下 —— 没有这个类，
// 整套外观（毛玻璃 / 拖拽把手 / 淡出）一条都不会生效。这里必须挂上。
function bootShell() {
  if (!win || win.isDestroyed()) return
  const css = fs.readFileSync(path.join(__dirname, 'shell.css'), 'utf8')
  // 挂在 dom-ready 而不是 did-finish-load：后者要等所有资源加载完，
  // 中间这段时间页面会以完全不透明的样子闪一下。
  win.webContents.insertCSS(css).catch(() => {})
  win.webContents
    .executeJavaScript(`document.documentElement.classList.add('is-desktop-shell'); true;`)
    .catch(() => {})
  syncShellClasses()
}

function createWindow() {
  const saved = readState()
  compact = Boolean(saved && saved.compact)

  win = new BrowserWindow({
    ...resolveBounds(saved),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // 毛玻璃本体。'under-window' 最稳；想要更「浮」的观感可换 'hud' 或 'popover'。
    vibrancy: 'under-window',
    visualEffectState: 'active',
    hasShadow: false,
    roundedCorners: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: 'Moments',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  })

  win.setAlwaysOnTop(true, 'floating')
  // 切到别的 Space / 别人全屏时也保持可见，否则一进全屏桌宠就「消失」了
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 注意：Electron 44 已移除 setMovableByWindowBackground()（旧版本 macOS 上用来
  // 「拖空白处移动窗口」）。现在的拖拽完全靠 shell.css 里的 -webkit-app-region，
  // 挂在吸顶的导航栏上——它滚动后仍固定在顶部，所以随时抓得到。
  win.setMovable(true)

  win.loadURL(APP_URL)

  // 每次文档加载（首次进入 / 重载 / 整页跳转）都重新注入一次；
  // 站内 SPA 跳转不重载文档，只需同步状态类。
  win.webContents.on('dom-ready', bootShell)
  win.webContents.on('did-navigate-in-page', syncShellClasses)

  win.on('focus', syncShellClasses)
  win.on('blur', syncShellClasses)

  const scheduleSave = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(writeState, 400)
  }
  win.on('move', scheduleSave)
  win.on('resize', scheduleSave)
  win.on('closed', () => {
    win = null
  })

  // 站外链接交给系统浏览器，别把桌宠变成浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('https://nefelibatai4.github.io/moments')) shell.openExternal(url)
    return { action: 'deny' }
  })

  // 无边框窗口没有标题栏可点，用右键菜单补上必要操作
  win.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      { label: compact ? '展开为完整窗口' : '收起为紧凑窗口', click: toggleCompact },
      { type: 'separator' },
      {
        label: '窗口置顶',
        type: 'checkbox',
        checked: win.isAlwaysOnTop(),
        click: (item) => win.setAlwaysOnTop(item.checked, 'floating'),
      },
      { label: '重载', click: () => win.webContents.reload() },
      { type: 'separator' },
      { label: '退出 Moments', click: () => app.quit() },
    ]).popup({ window: win })
  })

  // 无边框窗口丢了系统快捷键，手工补回最常用的几个
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = String(input.key || '').toLowerCase()
    const cmd = input.meta || input.control
    if (cmd && key === 'q') {
      event.preventDefault()
      app.quit()
    } else if (cmd && key === 'r') {
      event.preventDefault()
      win.webContents.reload()
    } else if (cmd && input.shift && key === 'm') {
      event.preventDefault()
      toggleCompact()
    } else if (input.key === 'Escape' && compact) {
      event.preventDefault()
      toggleCompact()
    }
  })
}

function toggleCompact() {
  if (!win) return
  compact = !compact
  const target = compact ? COMPACT_SIZE : NORMAL_SIZE
  const b = win.getBounds()
  win.setBounds(
    resolveBounds({ ...target, x: b.x, y: b.y }),
    true // animate：macOS 上带过渡，更像桌宠而不是网页
  )
  syncShellClasses()
  writeState()
}

function toggleVisible() {
  if (!win) return
  if (win.isVisible() && win.isFocused()) {
    win.hide()
  } else {
    win.show()
    win.focus()
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]))

  try {
    createWindow()
  } catch (err) {
    // 启动阶段抛异常若不处理会变成 unhandled rejection：窗口不出现、没有任何提示，
    // 只能干等到超时。开发时就踩过——一个已被移除的 API 让自检静默挂死了三分钟。
    console.error('[moments-desktop] 创建窗口失败：', err)
    app.exit(1)
    return
  }

  // 自检模式：npm run verify（验证类名与样式真的生效，见 selfcheck.js）
  if (process.env.MOMENTS_SELFCHECK === '1') require('./selfcheck')(win)

  // ⌥Space 呼出/隐藏。被别的 App 占用时 register 返回 false，这里明确报出来，
  // 免得出现「快捷键没反应但不知道为什么」。
  const ok = globalShortcut.register('Alt+Space', toggleVisible)
  if (!ok) console.warn('[moments-desktop] ⌥Space 注册失败，可能已被其他 App 占用')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else if (win) win.show()
  })
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => app.quit())
