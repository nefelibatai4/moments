# Design System: Raycast

## 1. Visual Theme & Atmosphere

Raycast's marketing site feels like the dark interior of a precision instrument — a Swiss watch case carved from obsidian. The background isn't just dark, it's an almost-black blue-tint (`#07080a`) that creates a sense of being inside a macOS native application rather than a website. Every surface, every border, every shadow is calibrated to evoke the feeling of a high-performance desktop utility: fast, minimal, trustworthy.

The signature move is the layered shadow system borrowed from macOS window chrome: multi-layer box-shadows with inset highlights that simulate physical depth, as if cards and buttons are actual pressed or raised glass elements on a dark desk. Combined with Raycast Red (`#FF6363`) — deployed almost exclusively in the hero's iconic diagonal stripe pattern — the palette creates a brand that reads as "powerful tool with personality." The red doesn't dominate; it punctuates.

Inter is used everywhere — headings, body, buttons, captions — with extensive OpenType features (`calt`, `kern`, `liga`, `ss03`) creating a consistent, readable typographic voice. The positive letter-spacing (0.2px–0.4px on body text) is unusual for a dark UI and gives the text an airy, breathable quality that counterbalances the dense, dark surfaces. GeistMono appears for code elements, reinforcing the developer-tool identity.

**Key Characteristics:**
- Near-black blue-tinted background (`#07080a`) — not pure black, subtly blue-shifted
- macOS-native shadow system with multi-layer inset highlights simulating physical depth
- Raycast Red (`#FF6363`) as a punctuation color — hero stripes, not pervasive
- Inter with positive letter-spacing (0.2px) for an airy, readable dark-mode experience
- Radix UI component primitives powering the interaction layer
- Subtle rgba white borders (0.06–0.1 opacity) for containment on dark surfaces
- Keyboard shortcut styling with gradient key caps and heavy shadows

## 2. Color Palette & Roles

### Primary
- **Near-Black Blue** (`#07080a`): Primary page background — the foundational void with a subtle blue-cold undertone
- **Pure White** (`#ffffff`): Primary heading text, high-emphasis elements
- **Raycast Red** (`#FF6363` / `hsl(0, 100%, 69%)`): Brand accent — hero stripes, danger states, critical highlights

### Secondary & Accent
- **Raycast Blue** (`hsl(202, 100%, 67%)` / ~`#55b3ff`): Interactive accent — links, focus states, selected items
- **Raycast Green** (`hsl(151, 59%, 59%)` / ~`#5fc992`): Success states, positive indicators
- **Raycast Yellow** (`hsl(43, 100%, 60%)` / ~`#ffbc33`): Warning accents, highlights
- **Blue Transparent** (`hsla(202, 100%, 67%, 0.15)`): Blue tint overlay for interactive surfaces
- **Red Transparent** (`hsla(0, 100%, 69%, 0.15)`): Red tint overlay for danger/error surfaces

### Surface & Background
- **Deep Background** (`#07080a`): Page canvas, the darkest surface
- **Surface 100** (`#101111`): Elevated surface, card backgrounds
- **Key Start** (`#121212`): Keyboard key gradient start
- **Key End** (`#0d0d0d`): Keyboard key gradient end
- **Card Surface** (`#1b1c1e`): Badge backgrounds, tag fills, elevated containers
- **Button Foreground** (`#18191a`): Dark surface for button text on light backgrounds

### Neutrals & Text
- **Near White** (`#f9f9f9` / `hsl(240, 11%, 96%)`): Primary body text, high-emphasis content
- **Light Gray** (`#cecece` / `#cdcdce`): Secondary body text, descriptions
- **Silver** (`#c0c0c0`): Tertiary text, subdued labels
- **Medium Gray** (`#9c9c9d`): Link default color, secondary navigation
- **Dim Gray** (`#6a6b6c`): Disabled text, low-emphasis labels
- **Dark Gray** (`#434345`): Muted borders, inactive navigation links
- **Border** (`hsl(195, 5%, 15%)` / ~`#252829`): Standard border color for cards and dividers
- **Dark Border** (`#2f3031`): Separator lines, table borders

### Semantic & Accent
- **Error Red** (`hsl(0, 100%, 69%)`): Error states, destructive actions
- **Success Green** (`hsl(151, 59%, 59%)`): Success confirmations, positive states
- **Warning Yellow** (`hsl(43, 100%, 60%)`): Warnings, attention-needed states
- **Info Blue** (`hsl(202, 100%, 67%)`): Informational highlights, links

### Gradient System
- **Keyboard Key Gradient**: Linear gradient from `#121212` (top) to `#0d0d0d` (bottom) — simulates physical key depth
- **Warm Glow**: `rgba(215, 201, 175, 0.05)` radial spread — subtle warm ambient glow behind featured elements

## 3. Typography Rules

### Font Family
- **Primary**: `Inter` — humanist sans-serif, used everywhere. Fallbacks: `Inter Fallback`, system sans-serif
- **System**: `SF Pro Text` — Apple system font for select macOS-native UI elements. Fallbacks: `SF Pro Icons`, `Inter`, `Inter Fallback`
- **Monospace**: `GeistMono` — Vercel's monospace font for code elements. Fallbacks: `ui-monospace`, `SFMono-Regular`, `Roboto Mono`, `Menlo`, `Monaco`
- **OpenType features**: `calt`, `kern`, `liga`, `ss03` enabled globally; `ss02`, `ss08` on display text; `liga` disabled (`"liga" 0`) on hero headings

### Hierarchy

| Role | Size | Weight | Line Height | Letter Spacing | Notes |
|------|------|--------|-------------|----------------|-------|
| Display Hero | 64px | 600 | 1.10 | 0px | OpenType: liga 0, ss02, ss08 |
| Section Display | 56px | 400 | 1.17 | 0.2px | OpenType: calt, kern, liga, ss03 |
| Section Heading | 24px | 500 | normal | 0.2px | OpenType: calt, kern, liga, ss03 |
| Card Heading | 22px | 400 | 1.15 | 0px | OpenType: calt, kern, liga, ss03 |
| Sub-heading | 20px | 500 | 1.60 | 0.2px | Relaxed line-height for readability |
| Body Large | 18px | 400 | 1.15 | 0.2px | OpenType: calt, kern, liga, ss03 |
| Body | 16px | 500 | 1.60 | 0.2px | Primary body text, relaxed rhythm |
| Body Tight | 16px | 400 | 1.15 | 0.1px | UI labels, compact contexts |
| Button | 16px | 600 | 1.15 | 0.3px | Semibold, slightly wider tracking |
| Nav Link | 16px | 500 | 1.40 | 0.3px | Links in navigation |
| Caption | 14px | 500 | 1.14 | 0.2px | Small labels, metadata |
| Caption Bold | 14px | 600 | 1.40 | 0px | Emphasized captions |
| Small | 12px | 600 | 1.33 | 0px | Badges, tags, micro-labels |
| Small Link | 12px | 400 | 1.50 | 0.4px | Footer links, fine print |
| Code | 14px (GeistMono) | 500 | 1.60 | 0.3px | Code blocks, technical content |
| Code Small | 12px (GeistMono) | 400 | 1.60 | 0.2px | Inline code, terminal output |

### Principles
- **Positive tracking on dark**: Unlike most dark UIs that use tight or neutral letter-spacing, Raycast applies +0.2px to +0.4px — creating an airy, readable feel that compensates for the dark background
- **Weight 500 as baseline**: Most body text uses medium weight (500), not regular (400) — subtle extra heft improves legibility on dark surfaces
- **Display restraint**: Hero text at 64px/600 is confident but not oversized — Raycast avoids typographic spectacle in favor of functional elegance
- **OpenType everywhere**: `ss03` (stylistic set 3) is enabled globally across Inter, giving the typeface a slightly more geometric, tool-like quality

## 4. Component Stylings

### Buttons
- **Primary Pill**: Transparent background, white text, pill shape (86px radius), multi-layer inset shadow (`rgba(255, 255, 255, 0.1) 0px 1px 0px 0px inset`). Hover: opacity 0.6
- **Secondary Button**: Transparent background, white text, 6px radius, `1px solid rgba(255, 255, 255, 0.1)` border, subtle drop shadow (`rgba(0, 0, 0, 0.03) 0px 7px 3px`). Hover: opacity 0.6
- **Ghost Button**: No background or border, gray text (`#6a6b6c`), 86px radius, same inset shadow. Hover: opacity 0.6, text brightens to white
- **CTA (Download)**: Semi-transparent white background (`hsla(0, 0%, 100%, 0.815)`), dark text (`#18191a`), pill shape. Hover: full white background (`hsl(0, 0%, 100%)`)
- **Transition**: All buttons use opacity transition for hover rather than background-color change — a signature Raycast interaction pattern

### Cards & Containers
- **Standard Card**: `#101111` surface, `1px solid rgba(255, 255, 255, 0.06)` border, 12px–16px border-radius
- **Elevated Card**: Ring shadow `rgb(27, 28, 30) 0px 0px 0px 1px` outer + `rgb(7, 8, 10) 0px 0px 0px 1px inset` inner — creates a double-ring containment
- **Feature Card**: 16px–20px border-radius, subtle warm glow (`rgba(215, 201, 175, 0.05) 0px 0px 20px 5px`) behind hero elements
- **Hover**: Cards brighten slightly via border opacity increase or subtle shadow enhancement

### Inputs & Forms
- Dark input fields with `#07080a` background, `1px solid rgba(255, 255, 255, 0.08)` border, 8px border-radius
- Focus state: Border brightens, blue glow (`hsla(202, 100%, 67%, 0.15)`) ring appears
- Text: `#f9f9f9` input color, `#6a6b6c` placeholder
- Labels: `#9c9c9d` at 14px weight 500

### Navigation
- **Top nav**: Dark background blending with page, white text links at 16px weight 500
- **Nav links**: Gray text (`#9c9c9d`) → white on hover, underline decoration on hover
- **CTA button**: Semi-transparent white pill at nav end
- **Mobile**: Collapses to hamburger, maintains dark theme
- **Sticky**: Nav fixed at top with subtle border separator

### Image Treatment
- **Product screenshots**: macOS window chrome style — rounded corners (12px), deep shadows simulating floating windows
- **Full-bleed sections**: Dark screenshots blend seamlessly into the dark background
- **Hero illustration**: Diagonal stripe pattern in Raycast Red — abstract, geometric, brand-defining
- **App UI embeds**: Showing actual Raycast command palette and extensions — product as content

### Keyboard Shortcut Keys
- **Key cap styling**: Gradient background (`#121212` → `#0d0d0d`), heavy multi-layer shadow (`rgba(0, 0, 0, 0.4) 0px 1.5px 0.5px 2.5px` + inset shadows), creating realistic physical key appearance
- Border-radius: 4px–6px for individual keys

### Badges & Tags
- **Neutral badge**: `#1b1c1e` background, white text, 6px radius, 14px font at weight 500, `0px 6px` padding
- Compact, pill-like treatment for categorization

## 5. Layout Principles

### Spacing System
- **Base unit**: 8px
- **Scale**: 1px, 2px, 3px, 4px, 8px, 10px, 12px, 16px, 20px, 24px, 32px, 40px
- **Section padding**: 80px–120px vertical between major sections
- **Card padding**: 16px–32px internal spacing
- **Component gaps**: 8px–16px between related elements

### Grid & Container
- **Max width**: ~1200px container (breakpoint at 1204px), centered
- **Column patterns**: Single-column hero, 2–3 column feature grids, full-width showcase sections
- **App showcase**: Product UI presented in centered window frames

### Whitespace Philosophy
- **Dramatic negative space**: Sections float in vast dark void, creating cinematic pacing between features
- **Dense product, sparse marketing**: The product UI screenshots are information-dense, but the surrounding marketing copy uses minimal text with generous spacing
- **Vertical rhythm**: Consistent 24px–32px gaps between elements within sections

### Border Radius Scale
- **2px–3px**: Micro-elements, code spans, tiny indicators
- **4px–5px**: Keyboard keys, small interactive elements
- **6px**: Buttons, badges, tags — the workhorse radius
- **8px**: Input fields, inline components
- **9px–11px**: Images, medium containers
- **12px**: Standard cards, product screenshots
- **16px**: Large cards, feature sections
- **20px**: Hero cards, prominent containers
- **86px+**: Pill buttons, nav CTAs — full pill shape

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Level 0 (Void) | No shadow, `#07080a` surface | Page background |
| Level 1 (Subtle) | `rgba(0, 0, 0, 0.28) 0px 1.189px 2.377px` | Minimal lift, inline elements |
| Level 2 (Ring) | `rgb(27, 28, 30) 0px 0px 0px 1px` outer + `rgb(7, 8, 10) 0px 0px 0px 1px inset` inner | Card containment, double-ring technique |
| Level 3 (Button) | `rgba(255, 255, 255, 0.05) 0px 1px 0px 0px inset` + `rgba(255, 255, 255, 0.25) 0px 0px 0px 1px` + `rgba(0, 0, 0, 0.2) 0px -1px 0px 0px inset` | macOS-native button press — white highlight top, dark inset bottom |
| Level 4 (Key) | 5-layer shadow stack with inset press effects | Keyboard shortcut key caps — physical 3D appearance |
| Level 5 (Floating) | `rgba(0, 0, 0, 0.5) 0px 0px 0px 2px` + `rgba(255, 255, 255, 0.19) 0px 0px 14px` + insets | Command palette, floating panels — heavy depth with glow |

### Shadow Philosophy
Raycast's shadow system is the most macOS-native on the web. Multi-layer shadows combine:
- **Outer rings** for containment (replacing traditional borders)
- **Inset top highlights** (`rgba(255, 255, 255, 0.05–0.25)`) simulating light source from above
- **Inset bottom darks** (`rgba(0, 0, 0, 0.2)`) simulating shadow underneath
- The effect is physical: elements feel like glass or brushed metal, not flat rectangles

### Decorative Depth
- **Warm glow**: `rgba(215, 201, 175, 0.05) 0px 0px 20px 5px` behind featured elements — a subtle warm aura on the cold dark canvas
- **Blue info glow**: `rgba(0, 153, 255, 0.15)` for interactive state emphasis
- **Red danger glow**: `rgba(255, 99, 99, 0.15)` for error/destructive state emphasis

## 7. Do's and Don'ts

### Do
- Use `#07080a` (not pure black) as the background — the blue-cold tint is essential to the Raycast feel
- Apply positive letter-spacing (+0.2px) on body text — this is deliberately different from most dark UIs
- Use multi-layer shadows with inset highlights for interactive elements — the macOS-native depth is signature
- Keep Raycast Red (`#FF6363`) as punctuation, not pervasive — reserve it for hero moments and error states
- Use `rgba(255, 255, 255, 0.06)` borders for card containment — barely visible, structurally essential
- Apply weight 500 as the body text baseline — medium weight improves dark-mode legibility
- Use pill shapes (86px+ radius) for primary CTAs, rectangular shapes (6px–8px) for secondary actions
- Enable OpenType features `calt`, `kern`, `liga`, `ss03` on all Inter text
- Use opacity transitions (hover: opacity 0.6) for button interactions, not color changes

### Don't
- Use pure black (`#000000`) as the background — the blue tint differentiates Raycast from generic dark themes
- Apply negative letter-spacing on body text — Raycast deliberately uses positive spacing for readability
- Use Raycast Blue as the primary accent for everything — blue is for interactive/info, red is the brand color
- Create single-layer flat shadows — the multi-layer inset system is core to the macOS-native aesthetic
- Use regular weight (400) for body text when 500 is available — the extra weight prevents dark-mode text from feeling thin
- Mix warm and cool borders — stick to the cool gray (`hsl(195, 5%, 15%)`) border palette
- Apply heavy drop shadows without inset companions — shadows always come in pairs (outer + inset)
- Use decorative elements, gradients, or colorful backgrounds — the dark void is the stage, content is the performer

## 8. Responsive Behavior

### Breakpoints
| Name | Width | Key Changes |
|------|-------|-------------|
| Mobile | <600px | Single column, stacked cards, hamburger nav, hero text reduces to ~40px |
| Small Tablet | 600px–768px | 2-column grid begins, nav partially visible |
| Tablet | 768px–1024px | 2–3 column features, nav expanding, screenshots scale |
| Desktop | 1024px–1200px | Full layout, all nav links visible, 64px hero display |
| Large Desktop | >1200px | Max-width container centered, generous side margins |

### Touch Targets
- Pill buttons: 86px radius with 20px padding — well above 44px minimum
- Secondary buttons: 8px padding minimum, but border provides visual target expansion
- Nav links: 16px text with surrounding padding for accessible touch targets

### Collapsing Strategy
- **Navigation**: Full horizontal nav → hamburger at mobile with slide-out menu
- **Hero**: 64px display → 48px → 36px across breakpoints
- **Feature grids**: 3-column → 2-column → single-column stack
- **Product screenshots**: Scale within containers, maintaining macOS window chrome proportions
- **Keyboard shortcut displays**: Simplify or hide on mobile where keyboard shortcuts are irrelevant

### Image Behavior
- Product screenshots scale responsively within fixed-ratio containers
- Hero diagonal stripe pattern scales proportionally
- macOS window chrome rounded corners maintained at all sizes
- No lazy-loading artifacts — images are critical to the product narrative

## 9. Agent Prompt Guide

### Quick Color Reference
- Primary Background: Near-Black Blue (`#07080a`)
- Primary Text: Near White (`#f9f9f9`)
- Brand Accent: Raycast Red (`#FF6363`)
- Interactive Blue: Raycast Blue (`hsl(202, 100%, 67%)` / ~`#55b3ff`)
- Secondary Text: Medium Gray (`#9c9c9d`)
- Card Surface: Surface 100 (`#101111`)
- Border: Dark Border (`hsl(195, 5%, 15%)` / ~`#252829`)

### Example Component Prompts
- "Create a hero section on #07080a background with 64px Inter heading (weight 600, line-height 1.1), near-white text (#f9f9f9), and a semi-transparent white pill CTA button (hsla(0,0%,100%,0.815), 86px radius, dark text #18191a)"
- "Design a feature card with #101111 background, 1px solid rgba(255,255,255,0.06) border, 16px border-radius, double-ring shadow (rgb(27,28,30) 0px 0px 0px 1px outer), 22px Inter heading, and #9c9c9d body text"
- "Build a navigation bar on dark background (#07080a), Inter links at 16px weight 500 in #9c9c9d, hover to white, and a translucent white pill button at the right end"
- "Create a keyboard shortcut display with key caps using gradient background (#121212→#0d0d0d), 5-layer shadow for physical depth, 4px radius, Inter 12px weight 600 text"
- "Design an alert card with #101111 surface, Raycast Red (#FF6363) left border accent, translucent red glow (hsla(0,100%,69%,0.15)), white heading, and #cecece description text"

### Iteration Guide
When refining existing screens generated with this design system:
1. Check the background is `#07080a` not pure black — the blue tint is critical
2. Verify letter-spacing is positive (+0.2px) on body text — negative spacing breaks the Raycast aesthetic
3. Ensure shadows have both outer and inset layers — single-layer shadows look flat and wrong
4. Confirm Inter has OpenType features `calt`, `kern`, `liga`, `ss03` enabled
5. Test that hover states use opacity transitions (0.6) not color swaps — this is a core interaction pattern

## 10. Moments 颜色令牌表（实现层）

本节是 `src/index.css` 的**唯一颜色来源**。组件只允许引用 `var(--token)`；
`scripts/verify-color-tokens.cjs` 会扫描非注释、非令牌定义行，硬编码颜色必须为 0。

> **同值**：表示深/浅主题使用完全相同的值，浅色主题直接继承 `:root` 的声明，
> 不在 `[data-theme="light"]` 里重复一份（避免两处漂移）。
> 只有 `--moment-glow*`、`--panel-preview-*` 四项需要深浅两套值。

### 10.1 既有核心令牌（值未改动）

| 令牌 | 深色 | 浅色 | 用途 |
|------|------|------|------|
| `--bg-page` | `#07080a` | `#f7f8f8` | 页面底色 |
| `--bg-card` | `#101111` | `#ffffff` | 卡片 / 骨架卡片 |
| `--bg-elevated` | `#191a1b` | `#f3f4f5` | 浮层、菜单、输入区 |
| `--bg-input` | `#07080a` | `#f7f8f8` | 输入框 |
| `--bg-badge` | `#1b1c1e` | `#e8e9ea` | 徽标 / 头像底 |
| `--text-primary` | `#f9f9f9` | `#18191a` | 主文字 |
| `--text-secondary` | `#cecece` | `#434345` | 次级文字 |
| `--text-tertiary` | `#9c9c9d` | `#6a6b6c` | 三级文字 |
| `--text-muted` | `#6a6b6c` | `#9c9c9d` | 弱化文字 |
| `--accent-blue` | `#55b3ff` | `#0066cc` | 链接 / 交互 |
| `--accent-red` | `#ff6363` | `#cc3333` | 危险 / 点赞 |
| `--accent-green` | `#5fc992` | `#339955` | 成功文字 |
| `--border-subtle` | `rgba(255,255,255,0.06)` | `rgba(0,0,0,0.06)` | 最轻描边 |
| `--border-standard` | `rgba(255,255,255,0.08)` | `rgba(0,0,0,0.08)` | 标准描边 |
| `--border-strong` | `rgba(255,255,255,0.1)` | `rgba(0,0,0,0.12)` | 强描边 |
| `--feed-divider` | `rgba(255,255,255,0.075)` | `#ececee` | 信息流 7px 色带 |
| `--btn-primary-bg` | `hsla(0,0%,100%,0.815)` | `#18191a` | 主按钮底 |
| `--btn-primary-text` | `#18191a` | `#ffffff` | 主按钮文字 |
| `--btn-secondary-bg` | `rgba(255,255,255,0.04)` | `rgba(0,0,0,0.04)` | 次按钮底 |
| `--btn-secondary-hover` | `rgba(255,255,255,0.06)` | `rgba(0,0,0,0.06)` | 次按钮 hover |
| `--btn-ghost-bg` | `transparent` | `transparent` | 幽灵按钮底 |
| `--card-shadow-outer` | `rgb(27,28,30) 0 0 0 1px` | `rgba(0,0,0,0.06) 0 0 0 1px` | 卡片外圈 |
| `--card-shadow-inner` | `rgb(7,8,10) 0 0 0 1px inset` | `none` | 卡片内圈 |
| `--popup-shadow` | 黑 50% 外圈 + 白 10% 光晕 | 黑 8% 外圈 + 黑 8% 投影 | 浮层阴影 |
| `--focus-ring` | `hsla(202,100%,67%,0.15) 0 0 0 3px` | `hsla(202,100%,50%,0.15) 0 0 0 3px` | 焦点环 |
| `--hover-wrap-bg` | `rgba(255,255,255,0.03)` | `rgba(0,0,0,0.03)` | 微光 / hover 底 |
| `--panel-scrim` | `rgba(10,11,14,0.42)` | `rgba(247,248,248,0.5)` | 插件玻璃面板顶栏 |
| `--moment-tint-*` | `oklch(0.30–0.32 …)` | `oklch(0.96–0.965 …)` | 每条动态的色卡 |

### 10.2 新增扩展令牌

#### 前景 / 媒体 / 兜底

| 令牌 | 深色 | 浅色 | 用途 |
|------|------|------|------|
| `--text-on-color` | `#ffffff` | 同值 | 彩色底 / 媒体底上的白字 |
| `--media-black` | `#000000` | 同值 | 视频 / 视频封面黑底 |
| `--accent-doll` | `#3b82f6` | 同值 | 玩偶/心情旧组件的默认主色 |
| `--border-fallback` | `rgba(0,0,0,0.08)` | 同值 | 旧组件 `--border` 兜底 |
| `--border-fallback-strong` | `rgba(0,0,0,0.14)` | 同值 | 旧组件 `--border` 强兜底 |

#### 遮罩 / 半透明控制层

| 令牌 | 深色 | 浅色 | 用途 |
|------|------|------|------|
| `--control-overlay` | `rgba(0,0,0,0.28)` | 同值 | 图片/气泡上的圆形按钮底 |
| `--scrim-media` | `rgba(0,0,0,0.55)` | 同值 | 图片 +N / 视频角标遮罩 |
| `--scrim-toast` | `rgba(0,0,0,0.45)` | 同值 | 灯箱计数提示条 |
| `--scrim-control` | `rgba(0,0,0,0.5)` | 同值 | 视频全屏关闭按钮底 |
| `--scrim-lightbox` | `rgba(0,0,0,0.86)` | 同值 | 图片灯箱背景 |
| `--scrim-viewer` | `rgba(0,0,0,0.92)` | 同值 | 视频全屏背景 |

#### 媒体 / 玻璃上的白色 alpha 阶

| 令牌 | 深色 | 浅色 | 用途 |
|------|------|------|------|
| `--on-media-12` | `rgba(255,255,255,0.12)` | 同值 | 灯箱重试按钮底 |
| `--on-media-14` | `rgba(255,255,255,0.14)` | 同值 | 回复引用条底 |
| `--on-media-16` | `rgba(255,255,255,0.16)` | 同值 | 灯箱关闭 / 翻页按钮底 |
| `--on-media-18` | `rgba(255,255,255,0.18)` | 同值 | 玻璃预览描边 / 内高光 |
| `--on-media-22` | `rgba(255,255,255,0.22)` | 同值 | 灯箱 spinner 轨道 |
| `--on-media-24` | `rgba(255,255,255,0.24)` | 同值 | 灯箱重试 hover / 视频关闭描边 |
| `--on-media-28` | `rgba(255,255,255,0.28)` | 同值 | 灯箱关闭 hover |
| `--on-media-30` | `rgba(255,255,255,0.3)` | 同值 | 灯箱翻页 hover |
| `--on-media-35` | `rgba(255,255,255,0.35)` | 同值 | 灯箱重试描边 |

#### 中性灰 alpha 阶

| 令牌 | 深色 | 浅色 | 用途 |
|------|------|------|------|
| `--neutral-8` | `rgba(127,127,127,0.08)` | 同值 | 媒体重试 hover |
| `--neutral-12` | `rgba(127,127,127,0.12)` | 同值 | 群提示条底 |
| `--neutral-16` | `rgba(127,127,127,0.16)` | 同值 | 群人数徽标底 |
| `--neutral-18` | `rgba(127,127,127,0.18)` | 同值 | 使用量进度槽 / 头像占位 |
| `--neutral-toggle-off` | `rgba(127,127,127,0.3)` | 同值 | 开关关闭态 |
| `--neutral-dashed` | `rgba(127,127,127,0.45)` | 同值 | 图片重试虚线描边 |

#### 浮层阴影（整条 shadow 收进令牌）

| 令牌 | 深色 | 浅色 | 用途 |
|------|------|------|------|
| `--shadow-popover-soft` | `0 8px 28px rgba(0,0,0,0.18)` | 同值 | 表情面板 |
| `--shadow-popover` | `0 8px 24px rgba(0,0,0,0.28)` | 同值 | 评论 / 消息菜单 |
| `--shadow-toast` | `0 2px 8px rgba(0,0,0,0.15)` | 同值 | 卡片上的浮动按钮 |
| `--shadow-toggle` | `0 1px 3px rgba(0,0,0,0.25)` | 同值 | 开关滑块 |
| `--shadow-glass` | `0 8px 24px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.18)` | 同值 | 玻璃预览卡 |
| `--shadow-unlock` | `0 14px 36px rgba(0,0,0,0.5)` | 同值 | 解锁提示 |

#### 动态柔光 / 面板预览（深浅不同）

| 令牌 | 深色 | 浅色 | 用途 |
|------|------|------|------|
| `--moment-glow` | `rgba(122,162,255,0.16)` | `rgba(0,0,0,0.05)` | 卡片鼠标柔光（有颜色卡） |
| `--moment-glow-soft` | `rgba(122,162,255,0.12)` | `rgba(0,0,0,0.04)` | 默认色卡片柔光 |
| `--panel-preview-text` | `#f4f4f5` | `#1a1f33` | 面板预览标题 |
| `--panel-preview-meta` | `rgba(255,255,255,0.72)` | `rgba(26,31,51,0.7)` | 面板预览说明 |

#### AI / 群聊暖色

| 令牌 | 深色 | 浅色 | 用途 |
|------|------|------|------|
| `--ai-bg-soft` | `rgba(255,159,28,0.1)` | 同值 | @Ace 芯片底 |
| `--ai-bg` | `rgba(255,159,28,0.12)` | 同值 | 设备未就绪提示条 |
| `--ai-bg-strong` | `rgba(255,159,28,0.14)` | 同值 | AI 等待中气泡 |
| `--ai-bg-emphasis` | `rgba(255,159,28,0.18)` | 同值 | AI 徽标 / hover |
| `--ai-bg-gradient` | `rgba(255,159,28,0.22)` | 同值 | 群头像渐变起点 |
| `--ai-border` | `rgba(255,159,28,0.35)` | 同值 | 暖色提示条描边 |
| `--ai-border-emphasis` | `rgba(255,159,28,0.5)` | 同值 | @Ace 芯片描边 |
| `--ai-marker` | `rgba(255,159,28,0.55)` | 同值 | AI 气泡左侧细线 |
| `--ai-marker-emphasis` | `rgba(255,159,28,0.85)` | 同值 | 等待中气泡左线 |
| `--ai-fill` | `rgba(255,159,28,0.9)` | 同值 | 群头像渐变实色 |
| `--ai-text` | `#b9701a` | 同值 | AI 徽标文字 |
| `--ai-text-emphasis` | `#9a5f12` | 同值 | 等待中气泡文字 |
| `--ai-pink-bg` | `rgba(255,110,160,0.22)` | 同值 | 群头像渐变终点 |
| `--ai-pink-fill` | `rgba(255,110,160,0.9)` | 同值 | 群头像渐变实色终点 |

#### 成功 / 危险提示

| 令牌 | 深色 | 浅色 | 用途 |
|------|------|------|------|
| `--success-strong` | `#3aa76d` | 同值 | 开关打开 / Ace 在线 / 隐身条 |
| `--success-bg` | `rgba(58,167,109,0.14)` | 同值 | 隐身预览提示条底 |
| `--success-border` | `rgba(58,167,109,0.35)` | 同值 | 隐身预览提示条描边 |
| `--danger-wash` | `rgba(220,60,60,0.1)` | 同值 | 群错误提示底 |

#### 暖纸色（维护页 / 开屏页）

| 令牌 | 深色 | 浅色 | 用途 |
|------|------|------|------|
| `--paper-bg-start` | `#fdf9f3` | 同值 | 暖纸渐变起点 |
| `--paper-bg-mid` | `#f8efe3` | 同值 | 暖纸渐变中段 |
| `--paper-bg-end` | `#f3e7d7` | 同值 | 暖纸渐变终点 |
| `--paper-ink` | `#3b322a` | 同值 | 暖纸主文字 |
| `--paper-ink-strong` | `rgba(59,50,42,0.82)` | 同值 | 暖纸强调文字 |
| `--paper-ink-muted` | `rgba(59,50,42,0.66)` | 同值 | 暖纸说明 |
| `--paper-ink-soft` | `rgba(59,50,42,0.62)` | 同值 | 暖纸徽标文字 |
| `--paper-ink-faint` | `rgba(59,50,42,0.58)` | 同值 | 暖纸备注 |
| `--paper-ink-ghost` | `rgba(59,50,42,0.48)` | 同值 | 开屏副标题 |
| `--paper-ink-label` | `rgba(59,50,42,0.44)` | 同值 | 暖纸单位标签 |
| `--paper-ink-fine` | `rgba(59,50,42,0.4)` | 同值 | 暖纸细则 |
| `--paper-wash` | `rgba(59,50,42,0.06)` | 同值 | 暖纸徽标底 |
| `--paper-border` | `rgba(59,50,42,0.08)` | 同值 | 暖纸徽标描边 |
| `--paper-border-strong` | `rgba(59,50,42,0.18)` | 同值 | 暖纸按钮描边 |
| `--paper-btn-bg` | `rgba(255,255,255,0.6)` | 同值 | 暖纸按钮底 |
| `--paper-glow` | `rgba(255,214,170,0.28)` | 同值 | 开屏暖光 |
| `--paper-glow-soft` | `rgba(255,214,170,0.22)` | 同值 | 维护页暖光 |
| `--paper-glow-fade` | `rgba(255,214,170,0)` | 同值 | 暖光透明终点 |
| `--paper-rule` | `rgba(120,92,66,0.55)` | 同值 | 开屏细横线 |
| `--paper-rule-fade` | `rgba(120,92,66,0)` | 同值 | 细横线透明终点 |

#### 使用量 / 装饰 / 下雨

| 令牌 | 深色 | 浅色 | 用途 |
|------|------|------|------|
| `--usage-bar-start` | `#6fa8dc` | 同值 | 流量条渐变起点 |
| `--usage-bar-end` | `#4a86c8` | 同值 | 流量条渐变终点 |
| `--usage-day-bar` | `rgba(111,168,220,0.55)` | 同值 | 七日柱状图 |
| `--decor-violet` | `#7c5cff` | 同值 | 面板装饰光斑 |
| `--decor-violet-fade` | `rgba(124,92,255,0)` | 同值 | 紫光斑透明终点 |
| `--decor-cyan` | `#22d3ee` | 同值 | 面板装饰光斑 |
| `--decor-cyan-fade` | `rgba(34,211,238,0)` | 同值 | 青光斑透明终点 |
| `--mood-rain-top` | `rgba(18,32,48,0.34)` | 同值 | 下雨卡片压暗层顶 |
| `--mood-rain-mid` | `rgba(24,44,66,0.26)` | 同值 | 下雨卡片压暗层中 |
| `--mood-rain-bottom` | `rgba(12,24,38,0.38)` | 同值 | 下雨卡片压暗层底 |

### 10.3 绿色合并取舍（视觉零变化的唯一例外）

改动前 `src/index.css` 有 3 个近似绿：

| 原值 | 原用途 | 归入 |
|------|--------|------|
| `#5fc992` | 成功文字（`--accent-green`） | 保留，不动 |
| `#3aa76d` | 开关打开态、隐身预览条 | `--success-strong` |
| `#2f9e6b` | Ace 在线小字 | `--success-strong` |

**取舍**：`#3aa76d` 与 `#2f9e6b` 的 RGB 只差 `(11, 9, 2)`，在 11px 小字上
ΔE 远低于可感知阈值，因此合并为 `--success-strong: #3aa76d`；`#5fc992`
仍保留为 `--accent-green` 专管"成功文字"，因为把成功文字也压到 `#3aa76d`
会产生可见的亮度变化。像素对比实测：合并只影响"在线"两个字和圆点，
最大单通道差 11、差异像素占比 0.009%，关键页面截图无可见回归。

### 10.4 令牌化验收

| 脚本 | 作用 |
|------|------|
| `node scripts/verify-color-tokens.cjs` | 硬编码颜色扫描 = 0；令牌完整性；深/浅主题 35 项关键组件 computed style × 令牌 |
| `node scripts/verify-color-visual.cjs` | 组件全家桶改前/改后像素对比；隐藏在线状态后要求 maxΔ=0 |
| `node scripts/verify-color-pages.cjs` | 真实动态/私聊/【我】页面深/浅 + 手机/桌面截图对比（maxΔ≤2） |

## 11. z-index 语义层级（实现层）

`src/index.css` 的 `:root` 是**全站 z-index 的唯一来源**。组件只能用
`z-index: var(--z-*)`，不得再写裸数字；确实需要新层时，按“谁盖住谁”在
下表中插值，并同步本节与 `scripts/verify-zindex-scale.cjs`。

本节的数值**沿用改造前的历史值**，任务只做“语义命名 + 集中定义”，
因此层叠行为零变化。判断层级时先看语义，不要只背数字。

### 11.1 层级表（从下到上）

| 令牌 | 值 | 语义 | 当前使用位置 |
|------|----|------|--------------|
| `--z-base` | `1` | 媒体容器内最底层 | 视频封面 `img` |
| `--z-raised` | `2` | 媒体容器内已就绪内容 | 视频 `video[data-video-loaded="1"]` |
| `--z-chrome` | `3` | 局部 chrome（角标、粘性搜索框） | 视频角标、桌面私聊粘性搜索框 |
| `--z-inline-control` | `5` | 行内浮动控件 | 聊天“回到底部”、双击点赞动画 |
| `--z-inline-menu` | `6` | 行内 ⋯ 菜单容器 | 评论/私聊消息操作菜单 |
| `--z-popover` | `10` | 卡片上的展开菜单 | 动态卡片 `⋯` 展开菜单 |
| `--z-sticky` | `20` | 顶部吸顶导航（基础/插件形态） | `.app-header` 基础规则 |
| `--z-nav` | `30` | 桌面竖栏 / 手机底栏 / 面板内嵌控件 | 桌面 `≥601px` 左侧竖栏、手机底栏、表情面板 |
| `--z-gate` | `40` | 整页门禁 | 维护页 `.maint-screen` |
| `--z-prompt` | `60` | 一次性提示 | 设备未就绪 `.unlock-prompt` |
| `--z-notice` | `80` | 非阻塞提示条 | 新版本提示 `.update-notice` |
| `--z-splash` | `90` | 开屏 | `.splash-screen` |
| `--z-lightbox` | `100` | 图片灯箱 | `.lightbox`（portal 到 `body`） |
| `--z-modal` | `110` | 确认弹层 | `.confirm-overlay` |
| `--z-debug` | `300` | 开发态调试面板 | `.viewport-debug`（仅 DEV 加载） |
| `--z-viewer` | `400` | 视频全屏查看器 | `.moment-video-lightbox` |

### 11.2 必须保持的覆盖关系

1. **开屏 > 提示条 > 常规内容**：`--z-splash(90) > --z-notice(80) > --z-sticky/--z-nav`，
   开屏期间新版本提示条不抢镜，但提示条仍高于动态页内容与导航。
2. **遮罩/弹层 > 内容**：图片灯箱 `--z-lightbox(100)` 高于底部输入行、
   手机底栏与吸顶导航；确认弹层 `--z-modal(110)` 又高于灯箱。
3. **灯箱 → 确认弹层 → 调试面板 → 视频查看器** 依次升高：
   `100 < 110 < 300 < 400`。调试面板必须能在灯箱打开时出现；视频全屏查看器
   是最高业务层。
4. **吸顶搜索框**：桌面私聊第三列的 `.chat-search` 用 `--z-chrome(3)` +
   `position: sticky`，只压住本列消息，低于导航（`--z-nav`）与所有浮层。
5. **插件 surface 特例**：桌面竖栏的 `--z-nav(30)` 只写在
   `html:not([data-surface])` 分支里；插件 `glass/panel` 形态不命中该分支，
   继续沿用基础 `.app-header` 的 `--z-sticky(20)`。这是刻意差异，不是遗漏。
6. **灯箱在手机端必须 portal 到 `body`**（踩坑 #66）：`z-index` 只在同一个
   层叠上下文里比较，滚动容器会给灯箱单独建层；改层级时不要把它移回 `main`。

### 11.3 验收

```bash
node scripts/verify-zindex-scale.cjs
```

脚本做两件事：静态扫描 `src/index.css`（注释与 `:root` 令牌定义除外）确认
没有裸 `z-index` 数值；再解析令牌表断言 11.2 的全部大小关系与插件特例源码结构。
