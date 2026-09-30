# 设计基线 MASTER：sidebarmobile 侧栏 UI

**版本**: 1.1.0 | **定稿日期**: 2026-09-29 | **修订**: 2026-09-30（用户实测反馈）| **状态**: 用户审查通过

本文件是侧栏 UI 的唯一视觉权威。后续所有页面/组件必须消费本文 token 与组件规格，禁止另起色值、圆角或字体。新界面状态先在 `demo/` 演进、审查后再回写本文件。

**1.1.0 修订内容**：九宫格菜单去掉底部页点（原规格写了"2×5 图标格 + 页点"，但页点会暗示可以左右翻页，而菜单只有一页、无翻页逻辑 —— 误导性 UI，按用户实测反馈移除），并明确 10 个格位清单与禁用格的原因标注要求。`demo/` 与 `src/` 已同步。

## 1. 设计输入来源

- **主题**：demo-studio 风格库六条目——`chrome-day` / `chrome-night` / `edge-day` / `edge-night` / `firefox-day` / `firefox-night`（复刻 Chrome Material You、Edge Fluent 2、Firefox Photon 的浅色与深色主题；核心色值取自三平台官方设计 token）。
- **排版**：手机浏览器（Via）交互模型——顶部网址栏、底部五键导航、底部弹层。
- **活样例**：`demo/`（index.html / themes.css / app.css / app.js，约 2000 行，可交互、经浏览器截图核验、控制台零报错）。`demo/themes.css` 是 token 的代码形态，与本文件 §3 一一对应。

## 2. 布局基线（已锁定）

```text
┌──────────────────────────┐
│ 顶栏：网址栏 + 深浅翻转钮 │  ← 唯一顶栏结构，双视图共用
├──────────────────────────┤
│                          │
│  视图 A 网站列表 /        │
│  视图 B 网页浏览          │  ← 单视图切换，内容占满中段
│  （弹层自底部升起覆盖）   │
│                          │
├──────────────────────────┤
│ 底栏：← → ⌂ [n] ≡       │  ← 五键常驻（含主页视图）
└──────────────────────────┘
```

- **顶栏**：左侧网址栏（整体圆角条，图标 + 抬头文本截断；浏览视图 = favicon + 页面标题/URL，需要时带「地址可能未同步」`?` 徽章；主页视图 = 产品图标 +「主页」）；右侧深浅主题翻转钮（当前家族内 day↔night 即时切换，图标随模式日/月）。顶栏除此两项外不放任何元素（无标签横条）。
- **底栏**：后退 / 前进 / 主页 / 标签数 / 菜单，两个视图始终渲染。主页视图下后退/前进禁用、主页钮 `aria-current` 高亮。
- **标签数按钮**：23×23px **圆角正方形**（固定 6px 圆角，不随主题变化），1.6px currentColor 描边内嵌数字。
- **标签管理**：唯一入口 = 标签列表弹层（底部升起）：行 = favicon + 标题 + URL + ⋮ + ×，活动行高亮，底部 ＋ 新建；行 hover/聚焦弹出图标子菜单（刷新/复制网址/普通打开/关闭）。
- **弹层族**：标签列表、九宫格菜单（**单页 2×5 图标格，无页点** —— 没有翻页逻辑就不放任何"还有下一页"的符号；格位依次为 夜间模式 / 网站列表 / 历史 / 复制网址 / 普通打开 / 分享 / 添加书签 / 电脑模式 / 站点设置 / 关闭全部，其中 分享 与 添加书签 为禁用态并在 `aria-label` 说明原因）、主题选择（六张主题卡各穿本主题预览 + 当前勾选）、站点设置（移动/桌面开关、UA 开关、Cookie 开关、能力状态徽章区）、历史（当前标签的 URL 历史栈，倒序列出，可点跳转）。统一行为：底部升起 + 背景压暗 + Esc/遮罩点击关闭 + `aria-labelledby`。
- **降级覆盖层**：警示图标 + 一句话原因 + URL 芯片 + 重试/在当前标签页打开/在新标签页打开/返回主页；不渲染外部 HTML；失败页保留此前成功条目标题。
- **悬停图标子菜单**（签名交互）：hover 150ms 打开 / 触摸点击切换 / 键盘聚焦 Enter·Space 打开；Esc 或外部点击关闭并回焦；`aria-haspopup="menu"` + `aria-expanded` + `role="menu"/"menuitem"`；纯图标按钮必有 aria-label 与可见焦点环；近底部自动上翻。
- **能力状态徽章**：未授权（中性灰）/ 可用（正常色）/ 已降级（警示色）/ 失败（错误色）/ 不确定（中性灰）；文案如实，禁止把降级显示为成功。

## 3. 六主题 Design Tokens

变量名即 CSS custom property（`html[data-theme="…"]` 作用域）。`on-primary/on-accent` 为主色上的文字色。

### 语义色（六主题共用，按明/暗分组）

| 组 | danger | warn | ok |
|----|--------|------|-----|
| `*-day` | `#C5221F` | `#B06000` | `#137333` |
| `*-night` | `#F28B82` | `#FDD663` | `#81C995` |

### chrome-day / chrome-night（Material You，胶囊大圆角）

| token | day | night |
|-------|-----|-------|
| primary | `#0B57D0` | `#A8C7FA` |
| on-primary | `#FFFFFF` | `#062E6F` |
| secondary | `#444746` | `#C4C7C5` |
| accent / on-accent | `#C2E7FF` / `#001D35` | `#004A77` / `#C2E7FF` |
| bg | `#FFFFFF` | `#202124` |
| surface / surface-2 | `#F1F3F4` / `#FFFFFF` | `#2D2E31` / `#202124` |
| text / text-secondary | `#1F1F1F` / `#5F6368` | `#E3E3E3` / `#C4C7C5` |
| border / border-strong | `#F1F3F4` / `#DADCE0` | `#3C4043` / `#3C4043` |
| radius-pill / card / ctrl / tab | `999 / 20 / 12 / 12px` | 同左 |
| font-ui | `"Google Sans", Roboto, "PingFang SC", sans-serif` | 同左 |

### edge-day / edge-night（Fluent 2，小圆角 + 细描边）

| token | day | night |
|-------|-----|-------|
| primary | `#0F6CBD` | `#479EF5` |
| on-primary | `#FFFFFF` | `#1B1B1B` |
| secondary | `#616161` | `#ADADAD` |
| accent / on-accent | `#EBF3FC` / `#242424` | `#082338` / `#FFFFFF` |
| bg | `#FFFFFF` | `#1F1F1F` |
| surface / surface-2 | `#F3F3F3` / `#FFFFFF` | `#2B2B2B` / `#1F1F1F` |
| text / text-secondary | `#242424` / `#616161` | `#FFFFFF` / `#ADADAD` |
| border / border-strong | `#E1DFDD` / `#D1D1D1` | `#3D3D3D` / `#525252` |
| radius-pill / card / ctrl / tab | `4 / 8 / 4 / 6px` | 同左 |
| font-ui | `"Segoe UI Variable Text", "Segoe UI", "PingFang SC", sans-serif` | 同左 |

### firefox-day / firefox-night（Photon，紧凑密度）

| token | day | night |
|-------|-----|-------|
| primary | `#0060DF` | `#00DDFF` |
| on-primary | `#FFFFFF` | `#15141A` |
| secondary | `#5B5B66` | `#BFBFC9` |
| accent / on-accent | `#DEEAFC` / `#15141A` | `#0250BB` / `#FBFBFE` |
| bg | `#FFFFFF` | `#1C1B22` |
| surface / surface-2 | `#F0F0F4` / `#F0F0F4` | `#2B2A33` / `#1C1B22` |
| text / text-secondary | `#15141A` / `#5B5B66` | `#FBFBFE` / `#BFBFC9` |
| border / border-strong | `#E0E0E6` / `transparent` | `#3A3944` / `#52525E` |
| radius-pill / card / ctrl / tab | `8 / 8 / 4 / 8px` | 同左 |
| font-ui | `system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", sans-serif` | 同左 |

阴影 `--shadow-elev` 各主题取值见 `demo/themes.css`（Material 双层 / Fluent 细边 / Photon 柔影）。

## 4. 动效清单

| 场景 | 规格 |
|------|------|
| 主题翻转 | 即时切换（无过渡动画），按钮图标日/月互换 |
| 弹层 | 底部升起 ~200ms ease-out + 遮罩渐显 |
| 悬停子菜单 | 150ms 延迟打开，淡出 + 4px 上移，近底自动上翻 |
| 主题预览/条目动效（参考） | Chrome = Ripple 涟漪扩散；Edge = Fluent-sheen 流光；Firefox = Photon-pop 弹起回位（`cubic-bezier(.34,1.56,.64,1)`） |
| 重载反馈 | 网址栏/内容区微光一闪（仅活动标签） |

## 5. 实现守则

- 一切颜色/圆角/字体消费 `--var`，禁止写死 hex；派生 hover 态用 `color-mix()` 从变量推导。
- 外部文本（网站名/URL/标题）一律 `textContent`，禁止 `innerHTML` 拼接。
- 系统字体栈，禁止引入网络字体与外部资源。
- 键盘：Tab 顺序合理、禁用项跳过、Enter/Space 开菜单、方向键菜单内循环、Esc 分层关闭（菜单→弹层）并回焦触发器。
- 图标：内联 SVG 或 unicode 线性符号，风格统一；纯图标按钮必有 `aria-label`。
- 控制台零 error / 零 warning 为验收门槛。

## 6. 防漂移

- 新组件先查本文件是否已有对应规格；没有则在 `demo/` 中演进 → 用户审查 → 回写本文件并升版本号。
- 任何与本文件的偏差必须在代码评审中以 `[必须修复]` 处理，除非本文件先被修订。
