import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
      const entry = readdirSync(join(outDir, 'assets')).find((f) => /^index-.*\.js$/.test(f))
      const version = entry ? entry.replace(/^index-/, '').replace(/\.js$/, '') : String(Date.now())
      writeFileSync(swPath, source.replaceAll('__SW_VERSION__', version))
      console.log(`  ✓ sw.js 版本号 = ${version}（外壳缓存按它失效）`)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_APP_BASE || '/moments/',
  plugins: [react(), serviceWorkerVersion()],
})
