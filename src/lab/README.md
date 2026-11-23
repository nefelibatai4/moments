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
3. 跑 `npm run lint` 和 `npm run build`。

## 边界

- 这一页不请求动态、私聊或钥匙，也不写任何用户数据。
- 「摸鱼」的鱼库只写本机 `localStorage`（按用户 id 分开）；在线渔友用 Supabase Realtime
  presence 互看战绩，不建表、不写库。频道里用一次性会话 id，不广播账号 id；别人的
  presence 元数据先清洗再展示（昵称/分数/鱼数都设上限）。
- 成就（6 枚）和图鉴完成度只从本机鱼库推导，不额外落盘；底部「清空本机鱼库」需要二次确认。
- 「摸鱼」的实现：`FishingGame.jsx`（玩法/拼写/在线渔友/成就）、`FishShape.jsx`（鱼的矢量画法）、
  `fishingData.js`（20 种鱼 + 100 个六级词 + 成就定义）。
- 需要展示真实数据的新实验，先说明用途和读取范围，再动。
- App 路由、导航、共享样式在实验室外；入口调整需要 i4 确认。
