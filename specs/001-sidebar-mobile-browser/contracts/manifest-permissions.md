# 契约：清单与权限

**版本**: v1 | **日期**: 2026-09-29 | **关联**: [research.md](../research.md) R1/R5/R6/R7 · 宪法 III/VII

双端差异只在构建期清单与适配层处理；业务代码不出现浏览器判断分支。

## 双端清单差异表

| 项 | Chrome (MV3) | Firefox (MV3) |
|----|--------------|----------------|
| 侧栏 | `"side_panel": { "default_path": "sidebar.html" }` + 权限 `sidePanel` | `"sidebar_action": { "default_panel": "sidebar.html", "default_title": "..." }`（不设 `browser_style`） |
| 后台 | `"background": { "service_worker": "background.js" }` | `"background": { "scripts": ["background.js"] }`（事件页） |
| UA 改写 | 可选权限 `declarativeNetRequestWithHostAccess` | 可选权限 `declarativeNetRequestWithHostAccess`（FF113+）；回退 `webRequest` + `webRequestBlocking` |
| 内容脚本 | 动态注册 `scripting`（可选权限） | 同左 |
| 最低版本策略 | 支持 `sidePanel` 的 Chrome | 支持 MV3 + `sidebar_action` 的 Firefox（≥115） |

## 基础权限（安装即声明，最小集）

| 权限 | 用途 | 评审理由（宪法 III 要求） |
|------|------|---------------------------|
| `storage` | 会话与网站列表持久化 | 核心功能必需 |
| `sidePanel`（仅 Chrome） | 侧栏入口 | 核心功能必需 |

- 不声明任何基础 host 权限；普通浏览与移动视口不需要。

## 可选权限（按需申请，FR-035）

| 触发动作 | 申请内容 | 粒度 |
|----------|----------|------|
| 开启「真实移动 UA」 | `declarativeNetRequestWithHostAccess` + `scripting` + 该来源 host 权限（Firefox 回退另含 `webRequest`/`webRequestBlocking`） | 精确来源 origin pattern |
| 开启「登录状态复用」 | `cookies` + `scripting` + 该来源 host 权限（已持有则复用） | 精确来源 origin pattern |

- **`scripting` 由两项授权共同申请（终审 A3）**：它是 Tier 2 注入的**前提**，不申请就永远拿不到。
  此前它只在契约里被声明、实现里从不请求，后果是"授权成功却收不到任何上报" —— 用户看到的是
  顶栏一直显示「地址可能未同步」，而没有任何提示说明原因。任一项授权成功即申请它。
- **共享权限的撤销必须逐权限名判断（终审 A3 的联动）**：`scripting` 与 host 权限 pattern 被两项
  授权共用，而 `browser.permissions.remove` 是按名字整体移除的。若撤销某一项时无条件移除，
  关掉 Cookie 会连带撤掉 UA 依赖的 `scripting` 与 host 权限，表现为「关了一个开关，另一个跟着失效」。
  `grant-coordinator` 因此逐个权限名判断：只有另一项授权不再需要它时才移除。
- 申请路径：`browser.permissions.request`；撤销路径：`browser.permissions.remove`；每次使用前 `permissions.contains` 复核（FR-030）。
- host 权限 pattern 由 OriginKey 生成：`https://example.com/*`（含端口时 `https://example.com:8443/*`）。
- **外部撤销的监听（FR-030）**：后台订阅 `browser.permissions.onRemoved`，把被撤销的 host 权限
  pattern 解析回来源键，注销对应 content script 并推送 `capabilities.changed`（runtime-messages.md）。
  没有这条通道，用户在浏览器设置里撤销权限后侧栏会一直显示旧状态。

## content script 注册策略

- 不使用静态 `content_scripts`（避免 `<all_urls>` 宽权限）。
- 授权成功后 `browser.scripting.registerContentScripts`：按来源匹配、`all_frames: true`、`run_at: "document_idle"`；撤销授权时注销对应 id。
- 脚本职责仅：URL/标题上报与新窗口意图上报（runtime-messages.md），不修改页面内容。
- **注入的模块边界**：content script 属于扩展自身的脚本，与业务代码同样遵守宪法 VII ——
  `browser.*` 只能经 `adapters/browser-api.ts` 出口访问，它不直接 import polyfill。

## DNR 规则策略（仅 UA 授权来源）

- **规则 id 由来源键哈希稳定推导**（`deriveRuleId`），不保存映射表：同一来源永远得到同一 id，
  因此 SW 重启后无需"重建映射"，`removeRuleIds` 也能精确命中。哈希到固定区间是为了避开
  与未来可能引入的其他规则 id 空间相撞。
- **规则是否生效以 DNR 会话规则实况为准（终审 A4）**：`ua-override.isApplied` 查
  `getSessionRules()` 而不是实例内的内存标记。会话规则存活于整个浏览器会话，比 Service Worker
  生命周期长；而后台**每条消息都新建协调器实例**，内存标记在那个路径上永远是空的 ——
  据它判定会把"已生效"错报成 `degraded`，徽章谎报「已降级为移动视口」。
  查询不可用（老浏览器无 `getSessionRules`）时回落实例内存，且方向安全：少报成功，不谎报 active。
- 规则条件：`requestDomains` 限定该来源域名、`resourceTypes: ["sub_frame"]`（扩展页内 iframe 请求）；action `modifyHeaders.set User-Agent`。
- 规则应用失败 → CapabilityState.ua = `degraded`（research R5 spike 验证此行为）。
