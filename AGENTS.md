# Moments — AI 工作入口

> 本文件会被 AI 工具自动加载（DSH、Claude Code、Cursor 等 30+ 工具支持 `AGENTS.md` 约定）。
> 读完本文后，**请继续读文末指向的私有知识库**——那里才有完整交接内容。

## 项目

**Moments** —— 邀请制私密朋友圈 + 一对一私聊。用户的个人站点，唯一在维护的项目。

| | |
|---|---|
| 线上 | https://nefelibatai4.github.io/moments/ |
| 技术栈 | Vite + React 19（纯 SPA）／Supabase（Postgres + Auth + Storage + Realtime）／GitHub Pages 托管／PWA + Capacitor iOS |
| 数据库 | Supabase `public` schema，**17 张表**（2026-10-12 起加了端到端加密相关：`user_keys`/`key_escrow`/`moment_keys`/`key_recovery_requests`/`key_escrow_access_log`；以及 `device_locations`/`ip_geo_cache`） |
| 当前状态 | **正常运营**（关闭倒计时早已结束，`SHUTDOWN_ENABLED = false`）。2026-11 的一批变化见文末「近期变化」；最新进度看私有库 `docs/STATUS.md` 末尾 |

## ⚠️ 硬约束

1. **本仓库是 Public。绝对不要提交任何密钥**：`service_role` key、VAPID 私钥、
   Management token、`.env`。提交前检查 `git status` 与待提交内容。
2. **下列路径被 `.gitignore` 排除是刻意的，不是遗漏**——它们只在本机，线上没有副本：
   `.env`、`supabase/`、`scripts/`、`db-backups/`、`Moments全量交接文档.md`。
   不要"帮忙"把它们加进**本公开仓库**的版本控制。
   （2026-09-24 起：这些本机文件在**私有仓库** `~/VSCood开发项目/moments-workspace/local-files/` 有副本，
   换机器时用那里的 `restore.cjs` 放回；详见该仓库 `docs/MIGRATION-WINDOWS.md`。）
3. **测试数据必须清理**：`scripts/` 下的验证脚本会创建临时账号（域名固定 `@example.com`）。
   一律用 `bash scripts/run-all-tests.sh` 跑（跑前跑后各清一次 + 审计，有残留以非 0 退出）；
   口令的失败限速计数（`auth_attempts`）也要清零，否则会把使用者自己的 IP 锁住。
   跑完要**看清理那几行**，不能只看最后一句"结果: N 通过"——
   曾经因为只看了最后一行，让 14 个测试账号静默泄漏（详见私有库 `docs/PITFALLS.md` #33）。
4. **数据库变更流程固定**：先备份 → 写 SQL 到 `db-backups/` → 记 `db-backups/CHANGELOG.md`
   → 执行 → 验证 → 写明回退方法。
5. **涉及「RLS 策略收紧」的迁移，必须等新版前端上线后再执行**；加性变更可以先行。
6. **改完必须验证**：`npm run lint`（要 0 error）+ `npm run build` + 跑验证脚本，再 push。

## 📍 路径说明（2026-10-22）

本仓库当前在本机位于 **`~/VSCood开发项目/moments`**（私有库在 `~/VSCood开发项目/moments-workspace`）。
**它可能会被再次移动**，所以：

- 文档里出现的绝对路径只当"上次看到的位置"，**以你实际打开的仓库为准**；
- `scripts/` 下的脚本一律用 `__dirname/..` 相对定位，不依赖绝对路径（不要新增写死路径）；
- 换位置后唯一需要手动处理的是**浏览器里的未打包扩展**：`chrome://extensions` 里"加载已解压的扩展程序"
  要重新指向 `<本仓库>/extension`。扩展已加固定 `key`，**ID 不会随路径变化**（详见 `extension/README.md`）。

## 完整交接内容在私有知识库

完整文档、进度追踪、运维手册、密钥都在**私有仓库**里（本公开仓库不含它们）：

```
git@github.com:nefelibatai4/moments-workspace.git
本机路径：~/VSCood开发项目/moments-workspace
```

**如果 `~/VSCood开发项目/moments-workspace` 不存在**：说明当前机器还没克隆，请向用户索取访问方式，不要凭猜测作答。

### 必读顺序

| # | 文件 | 为什么 |
|---|------|--------|
| 0 | `~/VSCood开发项目/moments-workspace/docs/HANDOFF.md` | **一页纸总览**：当前状态（站点是否在关闭倒计时）、这一轮做了什么、怎么回退、坑的索引、运维手册、待办 |
| 1 | `~/VSCood开发项目/moments-workspace/docs/STATUS.md` | **当前进度、下一步、待办** |
| 2 | `~/VSCood开发项目/moments-workspace/docs/ARCHITECTURE.md` | 技术栈、数据库结构、文件地图 |
| 3 | `~/VSCood开发项目/moments-workspace/docs/SECURITY.md` | 权限模型。**动数据前必读** |
| 4 | `~/VSCood开发项目/moments-workspace/docs/OPERATIONS.md` | 部署、验证、回滚、密钥轮换 |
| 5 | `~/VSCood开发项目/moments-workspace/docs/PITFALLS.md` | 踩坑记录 |
| 6 | `~/VSCood开发项目/moments-workspace/secrets/secrets.md` | 密钥明文，**仅在需要实际操作时读** |

## 关键认知（先记住这一条）

**「登录」不等于「能看内容」。** 门禁分两步，都在服务端（2026-09-30 起「邀请码」→「注册口令」）：
① **建号**由 Auth Hook「Before User Created」调用 `hook_signup_passphrase()` 比对口令（口令在 `app_settings`，
只有管理员可读，在【我】里更换；同 IP 30 分钟失败 5 次即限速）；
② **激活**靠 `profiles.approved`，所有读取策略都要求 `is_approved()`，必须凭 `claim_passphrase()` 激活。
⚠️ 建号那步的 Hook 需要在 Supabase Dashboard 里**手动开启一次**（跑了才会拦），
所以 `approved=false` 这道兜底永远要留着 —— 两边都成立才算安全。

## 常用命令

```bash
npm run dev       # 本地开发，http://localhost:5173/moments/
npm run build     # 生产构建
npm run lint      # oxlint，应为 0 error
npm run cap:sync  # 构建并同步到 iOS 工程（改动 iOS 包时必需）
```

部署：`git push origin main` → GitHub Actions 自动构建部署，约 30 秒。

## 收工前请做

1. 更新 `~/VSCood开发项目/moments-workspace/docs/STATUS.md`（做完的移入已完成为，写清下一步）。
2. 踩了新坑就追加到 `docs/PITFALLS.md` 并编号。
3. 改了数据库就确认 `db-backups/CHANGELOG.md` 有完整记录与回退方法。
4. 确认没有密钥进入本公开仓库。
5. 若站点状态有变化（例如关闭倒计时恢复），同步改 `docs/HANDOFF.md` §1 与本文的「当前状态」。

## 🧠 长期记忆在哪（新会话先读，不要凭记忆回答）

| 想知道什么 | 去哪读 |
|---|---|
| 用户偏好、沟通规矩 | `~/.dsh/AGENTS.md`（全局，自动加载） |
| 项目约定、硬约束 | 就是这份 `AGENTS.md` |
| 踩过的坑（编号递增，现到 **#153**） | 私有库 `docs/PITFALLS.md` —— **动手前先搜关键词** |
| 最近做了什么、当前状态 | 私有库 `docs/STATUS.md`（最新在最后） |
| 运维/环境/交接 | 私有库 `docs/HANDOFF.md`；架构 `ARCHITECTURE.md`；安全 `SECURITY.md` |
| Ace（群里那个 AI 分身）怎么配的 | 私有库 `docs/ACE-BRIEF.md`；桥 `scripts/ace-bridge.mjs` |

私有库路径：`~/VSCood开发项目/moments-workspace`。

## 🚩 近期变化（2026-11，别再按旧理解回答）

- **审批与"执行"口令都没了**：群里任何人只要让它动手，它就会做；执行前桥会自动给仓库拍快照
  （`scripts/ace-snapshot.mjs` → `~/Backups/moments-snapshots/`，`restore latest --yes` 可回退）。
- **Ace 的执行侧是 `danger-full-access`**（整机可写、可 `git commit/push`）；聊天侧只读（保证改动必然走快照）。
- **群消息只加载最近 300 条**（`loadGroupMessages` 必须倒序 + limit，曾经写成正序丢最新消息，
  PITFALLS #150）；Realtime 丢事件时，切前台/联网/订阅重连会补拉（#149）。
- **`?surface=panel/glass` 只在 < 900px 生效**：宽窗口自动退回整页形态（#151），否则小窗拉宽会像"网页坏了"。
- 私聊图片：加密上传（会话密钥）→ 读时签名 + 解密；失败时占位行会写明原因
  （`正在尝试…` / `解不开` / 额度类），**先看那行字再排查**（#152、#114）。

## ✅ 会话开场清单

1. 读全局偏好 `~/.dsh/AGENTS.md`（通常已自动加载）。
2. 读 `docs/STATUS.md` 最近 3 条 + `docs/PITFALLS.md` 里与任务相关的编号。
3. `git log --oneline -5` 看最近提交；`git status` 确认工作区是否干净。
4. 涉及桥/Ace 的，先看 `~/.dsh/ace-bridge.log` 尾部与 `node scripts/ace-bridge.mjs --selfcheck`。
5. 动手改代码前想一下"要不要先拍快照"（`node scripts/ace-snapshot.mjs "改动前"`）。

