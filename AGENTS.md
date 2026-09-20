# Moments — AI 工作入口

> 本文件会被 AI 工具自动加载（DSH、Claude Code、Cursor 等 30+ 工具支持 `AGENTS.md` 约定）。
> 读完本文后，**请继续读文末指向的私有知识库**——那里才有完整交接内容。

## 项目

**Moments** —— 邀请制私密朋友圈 + 一对一私聊。用户的个人站点，唯一在维护的项目。

| | |
|---|---|
| 线上 | https://nefelibatai4.github.io/moments/ |
| 技术栈 | Vite + React 19（纯 SPA）／Supabase（Postgres + Auth + Storage + Realtime）／GitHub Pages 托管／PWA + Capacitor iOS |
| 数据库 | Supabase `public` schema，8 张表 |

## ⚠️ 硬约束

1. **本仓库是 Public。绝对不要提交任何密钥**：`service_role` key、VAPID 私钥、
   Management token、`.env`。提交前检查 `git status` 与待提交内容。
2. **下列路径被 `.gitignore` 排除是刻意的，不是遗漏**——它们只在本机，线上没有副本：
   `.env`、`supabase/`、`scripts/`、`db-backups/`、`Moments全量交接文档.md`。
   不要"帮忙"把它们加进版本控制。
3. **测试数据必须清理**：`scripts/` 下的验证脚本会创建临时账号并占用邀请码。
   一律用 `bash scripts/run-all-tests.sh` 跑（跑前跑后各清一次 + 审计，有残留以非 0 退出）；
   **邀请码只复位、绝不删除**。跑完要**看清理那几行**，不能只看最后一句"结果: N 通过"——
   曾经因为只看了最后一行，让 14 个测试账号静默泄漏（详见私有库 `docs/PITFALLS.md` #33）。
4. **数据库变更流程固定**：先备份 → 写 SQL 到 `db-backups/` → 记 `db-backups/CHANGELOG.md`
   → 执行 → 验证 → 写明回退方法。
5. **涉及「RLS 策略收紧」的迁移，必须等新版前端上线后再执行**；加性变更可以先行。
6. **改完必须验证**：`npm run lint`（要 0 error）+ `npm run build` + 跑验证脚本，再 push。

## 完整交接内容在私有知识库

完整文档、进度追踪、运维手册、密钥都在**私有仓库**里（本公开仓库不含它们）：

```
git@github.com:nefelibatai4/moments-workspace.git
本机路径：~/moments-workspace
```

**如果 `~/moments-workspace` 不存在**：说明当前机器还没克隆，请向用户索取访问方式，不要凭猜测作答。

### 必读顺序

| # | 文件 | 为什么 |
|---|------|--------|
| 1 | `~/moments-workspace/docs/STATUS.md` | **当前进度、下一步、待办** |
| 2 | `~/moments-workspace/docs/ARCHITECTURE.md` | 技术栈、数据库结构、文件地图 |
| 3 | `~/moments-workspace/docs/SECURITY.md` | 权限模型。**动数据前必读** |
| 4 | `~/moments-workspace/docs/OPERATIONS.md` | 部署、验证、回滚、密钥轮换 |
| 5 | `~/moments-workspace/docs/PITFALLS.md` | 踩坑记录 |
| 6 | `~/moments-workspace/secrets/secrets.md` | 密钥明文，**仅在需要实际操作时读** |

## 关键认知（先记住这一条）

**「登录」不等于「能看内容」。** `auth.signUp` 是公开端点、不校验邀请码，
所以邀请制做在数据层：新账号 `profiles.approved = false`，所有读取策略都要求 `is_approved()`。
未激活账号能登录但读不到任何一行，必须凭 `claim_invite_code()` 原子认领邀请码才会被激活。

## 常用命令

```bash
npm run dev       # 本地开发，http://localhost:5173/moments/
npm run build     # 生产构建
npm run lint      # oxlint，应为 0 error
npm run cap:sync  # 构建并同步到 iOS 工程（改动 iOS 包时必需）
```

部署：`git push origin main` → GitHub Actions 自动构建部署，约 30 秒。

## 收工前请做

1. 更新 `~/moments-workspace/docs/STATUS.md`（做完的移入已完成为，写清下一步）。
2. 踩了新坑就追加到 `docs/PITFALLS.md` 并编号。
3. 改了数据库就确认 `db-backups/CHANGELOG.md` 有完整记录与回退方法。
4. 确认没有密钥进入本公开仓库。
