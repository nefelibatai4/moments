// Moments 面板浮层（真·毛玻璃）。
//
// ── 这个文件是怎么被加载的 ────────────────────────────────────────
// 不是声明式 content script（那需要 `<all_urls>` 主机权限 —— 等于给扩展
// 「读取你在所有网站上的数据」的能力，对私密圈这种产品是不可接受的授权）。
// 而是：点扩展图标 → background 拿到 `activeTab`（**那一刻**才临时获得当前标签页
// 的访问权）→ `chrome.scripting.executeScript` 把这个文件注进当前页面。
//
// ── 为什么这样才有真毛玻璃 ────────────────────────────────────────
// Chrome 的 action 弹窗是浏览器自己画的独立小窗，**窗口不透明**，网页拿不到
// 透明/模糊的权力；`backdrop-filter` 只能模糊"同一个文档里它背后的内容"，
// 弹窗背后没有可采样的像素。改成注入到网页里之后，浮层就是这个文档的一部分，
// `backdrop-filter` 模糊的就是真实的网页内容 —— 主页可见、且是糊的。
//
// ── 为什么用 Shadow DOM ──────────────────────────────────────────
// 两个方向都要隔离：① 宿主网页的 CSS（`* { }`、`img { }` 之类）不能把面板搞乱；
// ② 我们的样式不能漏进宿主网页。Shadow root 一次解决两边。
//
// ⚠️ 已知边界：
//   * `chrome://` 内置页、扩展商店、PDF 阅读器等**不允许注入** → background 直接走兜底小窗；
//   * 宿主网页的 CSP 可能挡住面板里的 iframe（`frame-src`）→ 见下方"兜底"一节；
//   * 宿主网页若给 html/body 加了 `transform` / `filter`，会创建新的 backdrop root，
//     `backdrop-filter` 只采样那个子树 → 毛玻璃会退化成"半透明染色"。
//     这是浏览器规范行为，我们无法绕过；退化成染色时观感仍然合理（不会坏掉）。
//
// ⚠️ 这个文件是**可重复注入**的：每次点图标都会再跑一遍。
//    所以它以"切换"语义实现（已存在就关掉），见 toggle()。

;(() => {
  const log = (...args) => console.log('[moments-panel]', ...args)
  const ROOT_ID = '__moments_panel_root__'
  // `?surface=glass` 是给网页的"我现在跑在毛玻璃面板里"信号（见 src/lib/surface.js）：
  // 网页据此把**整页背景设为透明**并收紧排版。不传的话网页会照常画自己的不透明底色——
  // 那样浮层的毛玻璃就被整页底色盖住了，看起来"毛玻璃完全没生效"（真实踩过的 bug）。
  const SITE_URL = 'https://nefelibatai4.github.io/moments/chat?surface=glass'
  const CLOSE_ON_ESCAPE = true
  // 等 iframe 里的网页报"我加载好了"。超时说明被宿主网页的 CSP 挡了 → 兜底。
  const FRAME_READY_TIMEOUT_MS = 5000

  // 重复注入时先切换掉（点第二下 = 关掉）。
  // ⚠️ 用元素上的 expando 属性，不要用 CustomEvent —— 事件需要有人监听，
  //    而"谁在监听"这件事在重复注入的场景下最容易漏（第一版就是这么漏掉的：
  //    派发了事件但没人接，于是"点第二下"什么也没发生）。
  const existing = document.getElementById(ROOT_ID)
  if (existing) {
    if (typeof existing.__momentsPanelClose === 'function') existing.__momentsPanelClose()
    else existing.remove() // 上一版留下的节点（没有 expando）也能关掉
    return
  }

  // ---------------------------------------------------------------- 设置
  // 与 src/lib/panelBackground.js 的 panelBgStyle() **必须保持一致**：
  // 扩展没有打包器，import 不到网页代码，只能各写一份。
  // scripts/verify-extension-panel.cjs 里有一条等价性断言盯着它们别漂移。
  const DEFAULT_SETTINGS = { mode: 'glass', tint: 'theme', blur: 12 }

  function panelBgStyle(settings, theme) {
    const dark = settings.tint === 'theme' ? theme !== 'light' : settings.tint === 'dark'
    if (settings.mode === 'solid') {
      return { background: dark ? '#07080a' : '#f7f8f8', backdropFilter: 'none' }
    }
    return {
      background: dark ? 'rgba(10, 11, 14, 0.55)' : 'rgba(247, 248, 248, 0.58)',
      backdropFilter: `blur(${settings.blur}px) saturate(160%)`,
    }
  }

  let settings = { ...DEFAULT_SETTINGS }
  let theme = 'dark'

  // ---------------------------------------------------------------- DOM
  const root = document.createElement('div')
  root.id = ROOT_ID
  // ⚠️ 这里必须用**内联 + !important**，不能只用 `all: initial`。
  //    浮层的根节点在宿主网页的 DOM 里，所以宿主网页的 CSS **能选中它**
  //    （Shadow DOM 只隔离它内部的后代，隔离不了它自己）。
  //    实测踩过的坑：测试页里有一条 `div { background: yellow !important; padding: 40px !important }`，
  //    内联的 `all: initial`（非 important）**压不过它** —— 结果是整个浮层根节点变成一块
  //    不透明白黄底、还带 40px 内边距，面板的 backdrop-filter 采样到的是这块黄底，
  //    毛玻璃看起来"完全没生效"。同一份 CSS 里内联 important 是层叠里优先级最高的，
  //    所以下面每一项都显式加 important。
  const pin = (prop, value) => root.style.setProperty(prop, value, 'important')
  pin('all', 'initial')
  pin('position', 'fixed')
  pin('inset', '0')
  pin('z-index', '2147483647')
  pin('background', 'transparent')
  pin('border', '0')
  pin('margin', '0')
  pin('padding', '0')
  pin('display', 'block')
  // 面板打开时要能点（宿主网页若写了 `div { pointer-events: none !important }` 会废掉交互）
  pin('pointer-events', 'auto')
  const shadow = root.attachShadow({ mode: 'open' })

  shadow.innerHTML = `
    <style>
      /* 根节点的重置靠上面的内联 !important（见那段注释）；
         这里只兜住"字体等可继承属性不会从宿主网页漏进来"。 */
      :host { font-family: -apple-system, "SF Pro Text", system-ui, sans-serif; }
      .sheet {
        position: fixed;
        inset: 0;
        display: flex;
        /* 贴右上角：面板只占上方一小块，其余都留给网页本身（"融入主页"） */
        justify-content: flex-end;
        align-items: flex-start;
        padding: 10px;
        box-sizing: border-box;
        font-family: -apple-system, "SF Pro Text", system-ui, sans-serif;
      }
      /* 面板本身才是毛玻璃：backdrop-filter 作用在它身上，模糊它背后的网页。
         高度：使用者 2026-09-23 明确要求"只保留上面四分之一"，所以是 25vh
         （下限 200px 是为了在很矮的窗口里仍然能用；上限不设，随屏幕走）。 */
      .panel {
        position: relative;
        width: min(420px, 100%);
        height: max(200px, 25vh);
        border-radius: 14px;
        /* 薄亮边框 + 内侧高光：glassmorphism 里"像玻璃"的关键不只是模糊，
           还有这圈被光打亮的边缘（只做模糊会像贴了层塑料膜）。 */
        border: 1px solid rgba(255, 255, 255, 0.18);
        box-shadow:
          0 10px 32px rgba(0, 0, 0, 0.38),
          inset 0 1px 0 rgba(255, 255, 255, 0.22);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        transition: background 0.18s ease, backdrop-filter 0.18s ease;
      }
      .panel[data-mode="solid"] {
        border-color: rgba(255, 255, 255, 0.08);
      }
      /* 窗口很窄时（手机宽度的浏览器窗口、或插件兜底小窗那种尺寸）：
         面板铺满，不再留那圈 10px 的缝与圆角 —— 本来就没多少可透出来的地方了。 */
      @media (max-width: 520px) {
        .sheet { padding: 0; }
        .panel {
          width: 100%;
          height: max(180px, 25vh);
          border-radius: 0 0 14px 14px;
          border-top: 0;
          border-right: 0;
          border-left: 0;
        }
      }
      /* 底部这条是**拖拽调高度**用的（使用者 2026-09-23：「长度我能自己拖拽么，
         而不是写死在代码里」）。它是一条独立的 10px 带子，**不压在 iframe 上面** ——
         压在下面会把网页最底部那一行（例如聊天输入框）挡住点不到。 */
      .grip {
        flex: 0 0 auto;
        height: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: ns-resize;
        /* 拖拽时别把文字选上（拖快了很容易选到网页里的字） */
        user-select: none;
        touch-action: none;
      }
      .grip-pill {
        width: 38px;
        height: 3px;
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.32);
        transition: background 0.15s ease, width 0.15s ease;
      }
      .grip:hover .grip-pill {
        background: rgba(255, 255, 255, 0.55);
        width: 52px;
      }
      iframe {
        flex: 1 1 auto;
        width: 100%;
        border: 0;
        /* iframe 自己必须透明，否则会把面板的毛玻璃盖住 */
        background: transparent;
        color-scheme: normal;
      }
      .fallback {
        position: absolute;
        inset: 0;
        display: none;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 24px;
        text-align: center;
        color: #f2f2f2;
        background: rgba(10, 11, 14, 0.86);
        font: 400 13px/1.6 -apple-system, system-ui, sans-serif;
      }
      .fallback.show { display: flex; }
      .fallback button {
        border: 0;
        border-radius: 18px;
        padding: 7px 18px;
        background: #4c8dff;
        color: #fff;
        font: 600 13px/1.4 -apple-system, system-ui, sans-serif;
        cursor: pointer;
      }
      .sheet[data-live="dark"] .fallback { color: #f2f2f2; }
    </style>
    <div class="sheet">
      <div class="panel" data-mode="glass">
        <iframe
          title="Moments 面板"
          allow="clipboard-read; clipboard-write"
          referrerpolicy="no-referrer"
        ></iframe>
        <div class="fallback">
          <p class="fallback-text">这个网页不让外面嵌页面，面板打不开。</p>
          <button type="button" class="fallback-open">在独立窗口打开</button>
        </div>
        <div class="grip" title="拖动调整高度（双击恢复默认）" aria-label="拖动调整面板高度">
          <span class="grip-pill"></span>
        </div>
      </div>
    </div>
  `

  const sheet = shadow.querySelector('.sheet')
  const panel = shadow.querySelector('.panel')
  const iframe = shadow.querySelector('iframe')
  const fallback = shadow.querySelector('.fallback')
  const fallbackText = shadow.querySelector('.fallback-text')
  const grip = shadow.querySelector('.grip')

  // ---------------------------------------------------------------- 高度拖拽
  // 默认高度是设计稿上的 25vh（"上方四分之一"），但**不写死**：
  // 拖动底部那条就能改，改完记进 chrome.storage.local，下次打开还是这个高度。
  const MIN_HEIGHT = 180
  const maxHeight = () => Math.max(MIN_HEIGHT, window.innerHeight - 24)

  function setHeight(px) {
    panel.style.height = `${Math.round(px)}px`
  }

  let dragState = null

  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault() // 别让宿主网页开始选文字/拖动
    dragState = { startY: e.clientY, startH: panel.getBoundingClientRect().height }
    try { grip.setPointerCapture(e.pointerId) } catch { /* 个别实现不支持，靠 move 兜住 */ }
  })

  grip.addEventListener('pointermove', (e) => {
    if (!dragState) return
    const next = dragState.startH + (e.clientY - dragState.startY)
    setHeight(Math.min(maxHeight(), Math.max(MIN_HEIGHT, next)))
  })

  function endDrag() {
    if (!dragState) return
    dragState = null
    const height = Math.round(panel.getBoundingClientRect().height)
    try { chrome.runtime.sendMessage({ type: 'panel:setHeight', height }) } catch { /* 扩展上下文失效，忽略 */ }
  }

  grip.addEventListener('pointerup', endDrag)
  grip.addEventListener('pointercancel', endDrag)
  // 双击恢复默认（拖到很怪的高度之后的一个明确出口）
  grip.addEventListener('dblclick', () => {
    panel.style.height = ''
    try { chrome.runtime.sendMessage({ type: 'panel:setHeight', height: null }) } catch { /* 同上 */ }
  })

  function applyStyle() {
    const style = panelBgStyle(settings, theme)
    panel.style.background = style.background
    panel.style.backdropFilter = style.backdropFilter
    panel.style.webkitBackdropFilter = style.backdropFilter
    panel.dataset.mode = settings.mode
    // 给浮层自己记一份"当前是深还是浅"，测试与调试都用得上
    const dark = settings.tint === 'theme' ? theme !== 'light' : settings.tint === 'dark'
    sheet.dataset.live = dark ? 'dark' : 'light'
  }

  let closed = false
  function close(reason) {
    if (closed) return
    closed = true
    clearTimeout(readyTimer)
    try { delete root.__momentsPanelClose } catch { /* 删不掉也无所谓 */ }
    document.removeEventListener('keydown', onKeyDown, true)
    if (onMessage) {
      try { chrome.runtime.onMessage.removeListener(onMessage) } catch { /* 扩展上下文失效，忽略 */ }
    }
    try { chrome.storage.onChanged.removeListener(onStorageChanged) } catch { /* 同上 */ }
    root.remove()
    log('已关闭：' + reason)
  }

  // 供"再点一次图标 = 关掉"使用（见文件开头那段切换语义的说明）
  root.__momentsPanelClose = () => close('再次点击图标')

  function onKeyDown(e) {
    if (!CLOSE_ON_ESCAPE) return
    if (e.key !== 'Escape') return
    e.stopPropagation()
    close('Esc')
  }

  // 点面板外面（留在 padding 缝里的那圈网页）就关掉。
  // 点面板内部不关 —— 使用者在里面聊天，误触一下就把面板关了会很难受。
  sheet.addEventListener('mousedown', (e) => {
    // 只认主键：右键/中键（有些人用中键关标签页、顺手就点在面板边上）不该关掉面板
    if (e.button !== 0) return
    if (e.target === sheet) close('点击面板外')
  })
  shadow.querySelector('.fallback-open').addEventListener('click', () => {
    openFallbackWindow('用户点击')
    close('改用独立窗口')
  })

  function openFallbackWindow(reason) {
    log('走兜底：' + reason)
    try {
      chrome.runtime.sendMessage({ type: 'panel:fallback', reason })
    } catch { /* 扩展上下文失效，忽略 */ }
  }

  // ---------------------------------------------------------------- 与扩展通信
  // iframe 里的网页加载成功后，content.js（all_frames）会通过 background 广播
  // `panel:frameReady`。收到就说明面板真的活了；一直收不到 → 被 CSP 挡了。
  function onMessage(msg) {
    if (msg && msg.type === 'panel:frameReady') {
      clearTimeout(readyTimer)
      log('面板里的网页已就绪')
    }
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return
    // ⚠️ 两个 key 必须**各自**判断：早退写成 `!changes.panelBg` 的话，
    // 只改主题（浅色/深色）时会在第一行就 return，面板颜色不跟着变。
    if (changes.panelBg) settings = { ...DEFAULT_SETTINGS, ...(changes.panelBg.newValue || {}) }
    if (changes.panelTheme) theme = changes.panelTheme.newValue || theme
    if (changes.panelBg || changes.panelTheme) applyStyle()
  }

  // 页面迟迟没就绪时，**只给提示和一个手动出口，不自动开窗**。
  //
  // 为什么不像最初设计的那样自动开独立小窗：实测发现"宿主网页的 CSP 挡掉 iframe"
  // 这件事**在扩展注入的场景下根本不成立** —— 扩展 content script 注入的元素不受
  // 页面 CSP 约束（`frame-src 'none'` 的页面上，面板里的网页照样加载成功，
  // 见 scripts/verify-extension-panel.cjs 的实测断言）。所以这条超时剩下能代表的
  // 只有"网络慢 / 站点挂了"，而那两种情况**独立小窗同样打不开** ——
  // 自动弹一个同样是空白的窗口只会让人困惑，不如把选择权交给使用者。
  let readyTimer = setTimeout(() => {
    fallback.classList.add('show')
    fallbackText.textContent = '面板里的网页没能加载出来（可能是网络问题）。'
  }, FRAME_READY_TIMEOUT_MS)

  // ---------------------------------------------------------------- 起
  applyStyle()
  document.documentElement.appendChild(root)
  document.addEventListener('keydown', onKeyDown, true)
  try {
    chrome.runtime.onMessage.addListener(onMessage)
    chrome.storage.onChanged.addListener(onStorageChanged)
  } catch { /* 扩展上下文失效，忽略 */ }

  // 先要一次设置，再挂 iframe：这样第一帧就是正确的背景（不会闪一下深色）
  try {
    chrome.runtime.sendMessage({ type: 'panel:getSettings' }, (res) => {
      if (res && res.settings) settings = { ...DEFAULT_SETTINGS, ...res.settings }
      if (res && res.theme) theme = res.theme
      // 上次拖过的高度优先（超过当前视口就夹回来，比如换了更小的屏幕）
      if (res && Number.isFinite(res.height)) {
        setHeight(Math.min(maxHeight(), Math.max(MIN_HEIGHT, res.height)))
      }
      applyStyle()
      if (!iframe.src) iframe.src = SITE_URL
    })
  } catch {
    iframe.src = SITE_URL
  }
  // 兜底：拿不到设置也不能一直不加载网页
  setTimeout(() => { if (!iframe.src) iframe.src = SITE_URL }, 150)

  log('浮层已挂载')
})()
