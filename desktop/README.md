# Moments 桌宠（macOS 外壳）

把 Moments 的私聊做成一个**毛玻璃、可随意拖拽、始终置顶**的桌面浮窗，不再受浏览器标签页限制。

## 快速开始

```bash
cd desktop
npm install
npm start
```

首次启动会停在登录页，正常登录即可（登录态保存在 Electron 自己的会话里，不会和浏览器互相影响）。

## 自检

```bash
npm run verify
```

它会真的把窗口开起来，然后检查「类名挂上了、样式真的生效了」，以退出码表示结果。

**为什么需要这个**：`shell.css` 里所有规则都作用在 `html.is-desktop-shell` 之下。一旦这个类没挂上，窗口照样能开、照样能用，**只是没有毛玻璃、也不能拖**——一种「看起来正常但全错」的失败。开发这个外壳时就真的漏挂过一次，所以留了这个自检。

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `⌥Space` | 呼出 / 隐藏窗口 |
| `⌘⇧M` | 在「完整窗口」和「紧凑窗口」之间切换 |
| `Esc` | 紧凑模式下按一下展开 |
| `⌘R` | 重载 |
| `⌘Q` | 退出 |

右键窗口任意位置还有一份菜单：收起/展开、切换置顶、重载、退出。

## 拖拽

拖**顶部导航栏**——它被设成了拖拽把手，并且是**吸顶**的，所以哪怕聊到很下面，它仍然固定在窗口顶部，随时抓得到。

导航栏上的链接和按钮已排除在拖拽区之外，所以点得动。

> 为什么不做「拖任意空白处」：Electron 44 已经移除了 `setMovableByWindowBackground()`（旧版 macOS 上用来实现这个的 API）。替代方案只有两个——用 CSS 覆盖一条固定拖拽区（会挡住最上方 36px 的点击），或者自己写一套鼠标跟踪。前者有代价、后者明显超出 MVP 范围，所以先用吸顶导航栏。想要「拖任意处」的话见下面「已知限制」。

## 改外观

**所有外观都在 `shell.css` 里**，它由 Electron 注入，网页本身不含这些规则。

- **毛玻璃浓度**：改 `body` 的 `background-color: color-mix(in srgb, var(--bg-page) 78%, transparent)` 里的 `78%`。数字越小越透。
- **玻璃材质**：改 `main.js` 里的 `vibrancy`。`'under-window'` 最稳；`'hud'` / `'popover'` 更「浮」。
- **默认窗口大小**：改 `main.js` 顶部的 `NORMAL_SIZE` / `COMPACT_SIZE`。

## 两个必须知道的坑

**1. 别用 `backdrop-filter` 做毛玻璃。**
它只能模糊页面内部位于元素背后的内容，**糊不了桌面和壁纸**。写出来会是「半透明塑料片」而不是毛玻璃。真毛玻璃只能由系统合成器给，也就是 `vibrancy`。这条踩过就知道有多浪费时间。

（`shell.css` 里确实用了一处 `backdrop-filter`，但那是吸顶导航栏模糊**页面内滚动上来的内容**——这是它的正确用法，和「糊桌面」是两件事。）

**2. `transparent: true` 必须配 `hasShadow: false`。**
否则透明区域会出现一个方形阴影边框，看起来像窗口没对齐。

## 开发时踩过、已修掉的两个坑（留作记录）

| 坑 | 现象 | 根因 |
|---|---|---|
| `shell.css` 的规则全部挂在 `html.is-desktop-shell` 下，但 `main.js` 从没挂过这个类 | 窗口能开、也能用，**只是没有毛玻璃、也不能拖** | 典型的「看起来正常但全错」——所以留了 `npm run verify` |
| 调用了 `win.setMovableByWindowBackground()` | 自检静默挂死 3 分钟后超时 | 该 API 在 Electron 44 已移除；异常抛在 `whenReady().then()` 里变成 unhandled rejection，窗口根本没创建，也没有任何提示 |

两条都被 `npm run verify` 挡住了：它现在会真开窗口、验样式，并且有 30 秒超时兜底。

## 已知限制

- **只支持 macOS。** Windows 的毛玻璃是另一套 API（Acrylic/Mica），要各写一份。
- **不能「拖任意空白处」**，只能拖顶部导航栏。原因见上面「拖拽」一节。想要的话，下一步可以加 preload + IPC 做鼠标跟踪式拖拽（约 40 行），代价是要在「拖拽」和「选中聊天文字」之间做取舍。
- 切换紧凑/完整模式时窗口尺寸会变，页面**不会**重新加载，但布局会重排。
- 深链接 `/moments/chat` 在 GitHub Pages 上返回的 HTTP 状态码是 404（内容正确）。Electron 仍会正常渲染，属于已知的托管平台行为，不是 bug。

## 开发模式

对着本地 dev server 跑：

```bash
# 另开一个终端
npm run dev            # 在项目根目录

# 然后
cd desktop
npm run start:dev
```

或直接指定任意地址：

```bash
MOMENTS_URL=http://localhost:5173/moments/chat npm start
```
