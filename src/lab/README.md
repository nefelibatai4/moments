# 实验室（`src/lab/`）

导航栏【实验室】页面的家，也是实验室模式的审计边界：Ace 可以自主改这里，
改到 `src/lab/` 外面的内容会被桥回滚（搬进正式页面要 i4 确认）。

## 加一个实验

1. 在 `src/lab/` 下新建组件/页面；样式写 `lab.css`，用 `src/index.css` 里的主题变量。
2. 在 `LabPage.jsx` 的 `EXPERIMENTS` 里加一条：
   - `to`：站内路由（`<Link>`）
   - `href`：整页跳转（现有工具靠 URL 参数触发）
   - `onClick: 'splash'`：本页覆盖层预览（开屏动画）
   - `onClick: 'fishing'`：本页进入「摸鱼」小游戏（不新增路由）
   - `onClick: 'turtle'`：本页进入「海龟汤」多人游戏（不新增路由）
3. 跑 `npm run lint` 和 `npm run build`。

## 边界

- 这一页不请求动态、私聊或钥匙，也不写任何用户数据。
- 「摸鱼」的鱼库只写本机 `localStorage`（按用户 id 分开）；在线渔友用 Supabase Realtime
  presence 互看战绩，不建表、不写库。频道里用一次性会话 id，不广播账号 id；别人的
  presence 元数据先清洗再展示（昵称/分数/鱼数/每个鱼种最近一个单词都设上限）。
- 成就（6 枚）和图鉴完成度只从本机鱼库推导，不额外落盘；底部「清空本机鱼库」需要二次确认。
- 鱼种详情（本机）显示鱼的样式、积分、已捕获数和「鱼种 → 拼对过的单词」；单词旁边带中文
  释义（旧词库留下的词也保留释义），旧版鱼库没有鱼种映射时退回显示同稀有度拼过的词。
  「拼对」明细同样显示释义，长释义换行完整显示，不做省略号截断。渔友鱼库也能点开详情，
  但只显示对方最近拼出的一个词（快照里也只存这一份）。
- 固定的鱼友在线时，把对方的 presence 快照（积分 / 鱼库 / 拼对数 / 每个鱼种最近一个词 /
  同步时间）按**查看者账号**写进本机 `localStorage`，key 是
  `moments-fishing-pal-v1:<userId>`。对方离线时用这份快照渲染鱼库并标「上次同步」；
  对方在线时仍以实时 presence 为准。不建表、不写库，换账号登录不会串数据。
- 「摸鱼」的实现：`FishingGame.jsx`（玩法/拼写/在线渔友/成就）、`FishShape.jsx`（鱼的矢量画法）、
  `fishingData.js`（20 种鱼 + 100 个六级词 + 成就定义）。
- 需要展示真实数据的新实验，先说明用途和读取范围，再动。
- App 路由、导航、共享样式在实验室外；入口调整需要 i4 确认。

## 「海龟汤」（2026-11-25 起接真 Ace）

- 文件：`TurtleSoup.jsx`（多人房间/排队等待判定/记分）、`turtleData.js`（10 个原创汤面 + clues + solution；
  `aceAnswer` / `aceJudge` 只保留给离线自检）、`lab.css` 末尾的 `.turtle-*` 样式。入口是 `LabPage.jsx`
  里的 `turtle` 卡片，不新增路由。
- 公共频道 `moments-turtle-soup-v1`，**不建表、不写库**：
  - presence：在线玩家（一次性 `sid`、本机随机 `pid`、昵称、进入时间、积分）。最早进入的浏览器只负责
    汇总房间状态；界面固定显示 Ace，不显示谁是汇总端。
  - broadcast：汇总端整包广播房间快照（汤面 id、提问、判定、猜测、结案/换题状态）；玩家广播提问、
    猜测和「请 Ace 出题/投降揭底」请求。公共频道不保证送达，新玩家进来时汇总端会补发当前快照。
  - 汤面/汤底来自 `turtleData.js` 的静态表；**播放中不渲染汤底（任何玩家都一样）**，结案后公开。
    汤底随前端包下发，所以这是界面约束，不是安全边界；频道里任何订阅者都可能看到发送的内容。
- **真 Ace 在频道外**：本机常驻进程 `scripts/ace-turtle-host.mjs`（`scripts/` 按仓库约定只在本机）
  用 anon key 订阅同一频道，收到 `question` / `guess` 后按 `puzzleId` 取该题汤底，调 DeepSeek，
  只广播 `ace-verdict`（yes / no / irrelevant / partial / correct / wrong）。汤底和模型原文不广播；
  DeepSeek 凭据只在本机 DSH 凭据文件里，不进仓库/日志。launchd 服务是 `com.moments.turtle-ace`。
- `TurtleSoup` 不再本地调用 `aceAnswer()` / `aceJudge()`：提问和猜底先以 pending 进房间，等
  `ace-verdict`；**5 秒没有判定就显示「Ace 不在线」**，不补答、不猜。判定后的短评只由判定词套固定模板，
  不包含汤底/线索。
- 任何玩家都可以请 Ace 出题、指定档案，或在推理中「投降，揭底」；换下一题不需要原汇总端在场。
  大厅和结案后可选难度（入门 / 进阶 / 烧脑），点「请 Ace 出题」按所选难度随机抽题；
  `ace-request` 会带上 `difficulty`，汇总端按它调 `pickTurtle(difficulty, excludeId)`。
- 积分只写本机 `localStorage`，key 为 `moments-turtle-soup-score-v1:<userId>`：
  猜中汤底按本局难度 +10 / +20 / +30（难度分值在 `TURTLE_DIFFICULTY[].points`）、
  被 Ace 回答的提问 +1，**没有主持加分**。用 `roundId`/提问 id 去重，刷新或重连不会重复加分。
  玩家 id 也存在本机（`moments-turtle-soup-player-v1:<userId>`），只用于关联自己的提问和猜测，不是账号 id。
- 收到的 broadcast / presence 都会清洗字段和上限；状态只接受当前汇总端（presence 中最早进入者）发来的
  版本，避免旧快照覆盖。公共频道无法验证发送者身份，Ace 主持端是客户端约定，不是服务端权限。
  开发态的验收可加 `?turtleChannel=...` 换独立频道，生产包不读这个参数。
