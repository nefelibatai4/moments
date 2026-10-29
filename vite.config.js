import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 给 Service Worker 盖版本号（待办 #6）。
 *
 * 为什么要盖：外壳缓存必须**按版本失效**。sw.js 是 public/ 下的静态文件，
 * 不带 hash，所以这里在构建时把里面的 `__SW_VERSION__` 换成**入口 chunk 的哈希**
 * —— 入口变了（说明代码变了）版本就变了 → 新 SW 的 activate 会把旧缓存删掉。
 * 开发服务器不跑这个插件，占位符原样保留（缓存名固定，但 Playwright 每次都是新 context，
 * 不会有残留）。
 */
function serviceWorkerVersion() {
  return {
    name: 'moments-sw-version',
    apply: 'build',
    // ⚠️ 必须用 closeBundle：public/ 下的文件是构建**之后**才被拷进 outDir 的，
    //    generateBundle 里根本看不到 sw.js（第一版就是栽在这，占位符没被替换）。
    closeBundle() {
      const outDir = join(process.cwd(), 'dist')
      const swPath = join(outDir, 'sw.js')
      let source
      try {
        source = readFileSync(swPath, 'utf-8')
      } catch {
        return   // 没有 sw.js（例如 build:app 的别的 outDir）就跳过
      }
      // ⚠️ 这一步必须容错：`dist/assets` 不存在时（构建中途失败、或别的 outDir）
      //    readdirSync 会抛 ENOENT，把整个构建带崩 —— 报出来的是"找不到目录"，
      //    真正的构建错误反而被这层盖住了（实测踩到，白查了一轮）。
      let entry = null
      try {
        entry = readdirSync(join(outDir, 'assets')).find((f) => /^index-.*\.js$/.test(f))
      } catch {
        entry = null
      }
      const version = entry ? entry.replace(/^index-/, '').replace(/\.js$/, '') : String(Date.now())
      writeFileSync(swPath, source.replaceAll('__SW_VERSION__', version))
      console.log(`  ✓ sw.js 版本号 = ${version}（外壳缓存按它失效）`)
    },
  }
}

/**
 * 首屏之前就把 Supabase 的连接准备好（DNS + TCP + TLS）。
 *
 * 为什么值：动态页要连它两次（REST 取数据、Storage 签地址/取图片），
 * 实测单次往返 300–500ms；握手本身在移动网络下能占掉其中一大截。
 * 用 preconnect 让浏览器在**解析 HTML 时**就并行去握手，而不是等 JS 跑起来。
 * 地址从 VITE_SUPABASE_URL 取（不在公开源码里硬编码项目 ref）。
 */
function supabasePreconnect() {
  return {
    name: 'moments-supabase-preconnect',
    transformIndexHtml(html) {
      const base = process.env.VITE_SUPABASE_URL
      if (!base) return html
      let origin
      try {
        origin = new URL(base).origin
      } catch {
        return html
      }
      return html.replace(
        '</head>',
        `  <link rel="dns-prefetch" href="${origin}">\n` +
        `  <link rel="preconnect" href="${origin}" crossorigin>\n` +
        '</head>',
      )
    },
  }
}

// https://vite.dev/config/
const GIT_SHA = (() => {
  // CI 里 git 命令不一定可用（浅克隆/无 git 二进制），优先用 GitHub 提供的环境变量
  const fromEnv = (process.env.GITHUB_SHA || process.env.CF_PAGES_COMMIT_SHA || '').trim()
  if (fromEnv) return fromEnv.slice(0, 7)
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() }
  catch { return 'dev' }
})()

export default defineConfig({
  // 构建标记：用**提交号**（而不是时间戳）——时间戳会让 CI 与本地构建出不同 hash，
  // 导致"线上产物和 dist 一致"这条核对失效（2026-10-29 实测踩到）。
  define: {
    __APP_BUILD__: JSON.stringify(GIT_SHA),
  },
  base: process.env.VITE_APP_BASE || '/moments/',
  plugins: [react(), serviceWorkerVersion(), supabasePreconnect()],
})
