# Moments

邀请制私密朋友圈 + 一对一私聊，纯单页应用（SPA）。

**线上**：https://nefelibatai4.github.io/moments/

---

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | Vite + React 19 + react-router-dom 7，纯 SPA，无 SSR |
| 后端 | Supabase（Postgres + Auth + Storage + Realtime） |
| 托管 | GitHub Pages，push `main` 后 GitHub Actions 自动构建部署（约 1 分钟） |
| 推送 | 数据库触发器 → `pg_net` → Supabase Edge Function（手写 RFC 8291/8292 加密）→ Service Worker |
| 移动端 | PWA + Capacitor（iOS） |
| 视觉 | Raycast 设计系统，规范见 `DESIGN.md` |

---

## 本地开发

```bash
npm install
npm run dev      # http://localhost:5173/moments/
```

> 开始前需要先准备好 `.env`（见下方「仅本地存在的文件」）。缺了它页面能打开，但所有数据请求都会失败。

### 常用命令

| 命令 | 作用 |
|------|------|
| `npm run dev` | 启动本地开发服务器 |
| `npm run build` | 生产构建，产出 `dist/` |
| `npm run lint` | oxlint 静态检查 |
| `npm run build:app` | 以 `base=/` 构建（供 Capacitor 使用） |
| `npm run cap:sync` | 构建并同步到 iOS 工程 |
| `npm run cap:open` | 用 Xcode 打开 iOS 工程 |

---

## 目录说明

### 已纳入版本控制（线上有，删了可 `git clone` 恢复）

| 路径 | 说明 |
|------|------|
| `src/` | 前端源码（页面、组件、lib） |
| `public/` | 静态资源（`sw.js`、PWA manifest、图标） |
| `index.html` | SPA 入口 |
| `ios/`、`build-ios.sh`、`capacitor.config.json`、`exportOptions.plist` | Capacitor iOS 工程与打包脚本 |
| `.github/workflows/` | GitHub Actions 部署流程 |
| `DESIGN.md` | Raycast 设计系统规范 |
| `vite.config.js`、`package.json`、`vercel.json`、`.oxlintrc.json` | 构建与工具配置 |

### ⚠️ 仅本地存在（线上没有，且是本机唯一副本）

被 `.gitignore` 排除是**故意的**——本仓库是 Public，密钥不能推上去。

| 路径 | 说明 | 丢失后果 |
|------|------|----------|
| `Moments全量交接文档.md` | 全部密钥明文、数据库结构、踩坑记录、运维流程 | 换机/换 AI 时失去唯一凭据来源 |
| `supabase/` | Edge Function 源码，**含 VAPID 私钥** | 无法重新部署推送；换密钥会导致所有已订阅浏览器失效 |
| `.env` | Supabase URL / anon key / service_role key / Management token | 本地开发与 SQL 脚本全部失效 |
| `db-backups/` | 数据库变更日志、迁移 SQL、回滚材料 | 失去数据库变更的审计与回退能力 |
| `scripts/` | SQL 执行工具与端到端验证脚本 | 需要重新编写 |

**这五项加起来只有约 350KB，请单独做加密备份。** 体积可以忽略，但没有任何一份在线上。

---

## 安全模型（要点）

**「登录」不等于「能看内容」。**

`auth.signUp` 是 Supabase 的公开端点，服务端不校验邀请码——任何人拿公开的 anon key 都能注册出账号。
因此邀请制做在数据层而不是 UI 层：新账号 `profiles.approved = false`，**所有读取策略都要求 `is_approved()`**。
未激活账号可以登录，但读不到任何一行、也写不进任何数据；必须凭 `claim_invite_code()` 原子认领一个有效邀请码才会被激活。

| 动作 | 谁可以 |
|------|--------|
| 读动态 / 评论 / 点赞 / 私聊 | 已激活的任何登录用户 |
| 发动态 / 评论 / 点赞 / 私聊 | 已激活 + 写入行的 `user_id` 必须是本人 |
| 编辑、删除动态 | 动态作者本人 |
| 删除评论 | 评论作者本人 **或** 该动态的作者 |
| 标记已读 | 消息接收方 |
| 撤回消息 | 消息发送方（前端限 2 分钟窗口） |
| 校验 / 认领邀请码 | 只能通过 RPC，且不可枚举 |

消息的字段级约束（改内容、改已读、改收发人）由 `tr_messages_immutable` 触发器强制——
RLS 只能管「哪些行可写」，管不了「哪些列可写」。

完整细节见 `Moments全量交接文档.md` 第十三章。

---

## 部署

```bash
git push origin main     # GitHub Actions 自动构建并部署到 GitHub Pages
```

Actions 需要两个 Secrets：`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`。

**数据库变更流程**：先备份 → 写 SQL 到 `db-backups/` → 记录到 `db-backups/CHANGELOG.md` → 执行 → 验证。
回退方法写在每个迁移文件末尾。涉及「策略收紧」的迁移必须等新版前端上线后再执行。

---

## 验证

`scripts/` 下有一套打真实后端的端到端验证脚本（共 123 项断言），改动后建议全跑一遍：

```bash
npm run dev    # 另开一个终端保持运行
node scripts/verify-phase-a.cjs   # 激活闸门与 RLS 权限边界
node scripts/e2e-phase-a.cjs      # 注册 → 激活 → 时间线
node scripts/e2e-phase-b.cjs      # 双账号实时同步
node scripts/e2e-ui.cjs           # ··· 菜单交互（赞/评论/删除）
node scripts/e2e-phase-c.cjs      # 评论删除 / 动态编辑 / 消息撤回
node scripts/e2e-phase-d.cjs      # 分页与图片压缩
```

脚本会创建临时账号并占用邀请码，结束（含异常路径）自动回滚清理。
