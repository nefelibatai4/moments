// 外壳自检：验证「类名挂上了、样式真的生效了」。
//
// 为什么需要它：shell.css 里所有规则都作用在 html.is-desktop-shell 之下，
// 一旦这个类没挂上，整套外观会静默失效 —— 窗口还是能开、还是能用，
// 只是没有毛玻璃、不能拖。这种「看起来正常但全错」的失败最难发现。
//
// 用法：npm run verify
// 通过退出码表示结果（0 通过 / 1 失败），方便接进流水线。
const { app } = require('electron')

function report(name, ok, detail) {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  → ${detail}` : ''}`)
  return ok
}

module.exports = function selfcheck(win) {
  const fail = (msg) => {
    console.error(`❌ ${msg}`)
    app.exit(1)
  }

  // 兜底：绝不允许自检无限挂住。窗口没起来、网络不通、页面报错，
  // 都应该以失败退出，而不是卡在那里让人等。
  const guard = setTimeout(() => {
    fail('自检超时（30 秒内没拿到探针结果）——窗口可能没创建，或页面加载失败')
  }, 30000)

  win.webContents.once('dom-ready', () => {
    // 等 bootShell 的 insertCSS / executeJavaScript 落地
    setTimeout(async () => {
      let probe
      try {
        probe = await win.webContents.executeJavaScript(`(() => {
          const header = document.querySelector('.app-header')
          const body = getComputedStyle(document.body)
          return {
            rootClasses: document.documentElement.className,
            bodyBackground: body.backgroundColor,
            bodyRadius: body.borderRadius,
            hasHeader: Boolean(header),
            headerAppRegion: header ? getComputedStyle(header).webkitAppRegion : null,
            headerUserSelect: header ? getComputedStyle(header).userSelect : null,
          }
        })()`)
      } catch (err) {
        return fail(`自检脚本注入失败：${err.message}`)
      }
      clearTimeout(guard)

      console.log('探针结果：', JSON.stringify(probe, null, 2))
      console.log('')

      let ok = true

      ok = report('html 上挂上了 is-desktop-shell', probe.rootClasses.includes('is-desktop-shell'), probe.rootClasses) && ok

      // 生效的最硬证据：这条规则只可能来自 shell.css
      ok = report('导航栏被设成拖拽把手（-webkit-app-region: drag）', probe.headerAppRegion === 'drag', String(probe.headerAppRegion)) && ok

      ok = report('导航栏禁用了文字选择（拖拽时不选中文字）', probe.headerUserSelect === 'none', String(probe.headerUserSelect)) && ok

      ok = report('圆角生效', probe.bodyRadius !== '0px', probe.bodyRadius) && ok

      // 底色必须半透明，否则原生毛玻璃透不出来
      const bg = probe.bodyBackground
      const opaque = bg === 'rgb(7, 8, 10)' || bg === 'rgb(247, 248, 248)'
      ok = report('body 底色是半透明（毛玻璃能透出来）', !opaque && bg !== 'rgba(0, 0, 0, 0)', bg) && ok

      if (!probe.hasHeader) {
        console.log('⚠️  没找到 .app-header —— 页面结构可能变了，拖拽把手会失效')
      }

      console.log('')
      console.log(ok ? '✅ 外壳自检通过' : '❌ 外壳自检失败')
      app.exit(ok ? 0 : 1)
    }, 1200)
  })
}
