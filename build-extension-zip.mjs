#!/usr/bin/env node
// 把 extension/ 打成 public/moments-extension.zip，供【我】页面下载给朋友。
//
// 为什么放在「构建时生成」，而不是把 zip 提交进仓库：
//   提交二进制的话，以后每次改 extension/ 都得记得手动重打一遍，
//   忘了就会**静默**发出旧版，而且没有任何人会察觉。
//   挂到 prebuild 上，zip 与 extension/ 永远出自同一次构建。
//
// 为什么脚本在仓库根目录，而不是 scripts/：
//   scripts/ 被 .gitignore 排除、只在本机存在，而 CI 是全新 clone ——
//   放那里的话 CI 根本没有这个脚本，构建会直接失败。
//
// 用法：
//   node build-extension-zip.mjs        （npm run build 会通过 prebuild 自动跑）

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SRC = join(ROOT, 'extension')
const OUT = join(ROOT, 'public', 'moments-extension.zip')
// zip 里套一层目录：解压后是一个文件夹，而不是一堆散文件
// （Chrome 的「加载已解压的扩展程序」要选目录，散在「下载」里根本认不出该选哪个）
const TOP = 'moments-extension'

// 少任何一个都会让扩展装不上，所以在打包前就挡住，
// 而不是等朋友下载完说一句「用不了」
const REQUIRED = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup.html',
  'popup.js',
  'popup.css',
  'config.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
]

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

for (const bin of ['zip', 'unzip']) {
  try {
    execFileSync(bin, ['-v'], { stdio: 'ignore' })
  } catch {
    fail(`找不到 ${bin} 命令，无法打包扩展`)
  }
}

if (!existsSync(SRC)) fail(`找不到扩展目录：${SRC}`)
for (const rel of REQUIRED) {
  if (!existsSync(join(SRC, rel))) fail(`扩展缺少必需文件：extension/${rel}`)
}

const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'))
if (!manifest.name || !manifest.version) fail('extension/manifest.json 缺少 name 或 version')

// 在临时目录里搭台：既让 zip 内的顶层目录名可控，也避免把仓库里的杂物卷进去
const stage = mkdtempSync(join(tmpdir(), 'moments-ext-'))
try {
  cpSync(SRC, join(stage, TOP), { recursive: true })
  // macOS 的 zip 会带 __MACOSX 资源分叉与 .DS_Store，必须清掉
  rmSync(join(stage, TOP, '.DS_Store'), { force: true })

  mkdirSync(dirname(OUT), { recursive: true })
  // 不先删的话 zip 是「更新」旧包，已经删掉的文件会残留在里面
  rmSync(OUT, { force: true })

  execFileSync('zip', ['-r', '-X', '-q', OUT, TOP, '-x', '*.DS_Store', '__MACOSX/*'], {
    cwd: stage,
  })

  // 自检：打成什么样就核对什么样，不信任 zip 的退出码
  const entries = execFileSync('unzip', ['-Z1', OUT], { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  if (entries.length === 0) fail('生成的 zip 是空的')

  const stray = entries.filter((e) => !e.startsWith(`${TOP}/`))
  if (stray.length > 0) fail(`zip 里混进了顶层目录之外的东西：${stray.slice(0, 5).join('、')}`)

  const junk = entries.filter((e) => e.includes('__MACOSX') || e.endsWith('.DS_Store'))
  if (junk.length > 0) fail(`zip 里混进了 macOS 杂物：${junk.slice(0, 5).join('、')}`)

  if (!entries.includes(`${TOP}/manifest.json`)) {
    fail(`zip 里没有 ${TOP}/manifest.json —— 层级不对，Chrome 会装不上`)
  }
  for (const rel of REQUIRED) {
    if (!entries.includes(`${TOP}/${rel}`)) fail(`zip 里缺少 ${TOP}/${rel}`)
  }

  const kib = (statSync(OUT).size / 1024).toFixed(0)
  console.log(
    `✅ 扩展包已生成：public/moments-extension.zip（${kib} KB，${entries.length} 项，${manifest.name} v${manifest.version}）`,
  )
} finally {
  rmSync(stage, { recursive: true, force: true })
}
