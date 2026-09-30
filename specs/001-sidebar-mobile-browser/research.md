# Phase 0 研究结论：侧栏移动浏览器

**日期**: 2026-09-29 | **关联**: [spec.md](spec.md) · [plan.md](plan.md)

本文档解决 Technical Context 中的全部未知项。每项包含：决定 / 理由 / 已评估的替代方案。

## R1 侧栏入口：双清单构建期分流

- **决定**: Chrome 使用 `side_panel` 清单键 + `sidePanel` API；Firefox 使用 `sidebar_action` 清单键（`default_panel` 指向同一面板页面）。两份清单在构建期生成，面板 HTML/JS 完全相同，业务代码不判断浏览器。
- **理由**: 两者清单结构互不兼容（键名、后台注册方式不同），但面板页能力一致（均可访问扩展 API）。已核实 MDN `sidebar_action` 支持 MV3（Firefox ≥115，`browser_style` 自 FF118 不可用，不设置即可）。
- **替代方案**: 运行时探测后动态注册 —— 违反宪法 VII（双端差异在构建/清单层解决），拒绝。

## R2 网页内嵌与嵌入失败检测

- **决定**: 以 iframe 为唯一内嵌方案；嵌入失败用「iframe load/onerror 事件 + 授权站点 content script 心跳缺失」做启发式判定，界面上始终提供「在普通标签页打开」的常驻操作。
- **理由**: `X-Frame-Options` / CSP `frame-ancestors` 由目标网站控制，扩展无法绕过；Chrome 对被 XFO 拦截的 iframe 同样触发 load 事件（加载错误页），因此 Tier 1（无 host 权限）无法编程区分「被拦截」与「跨域加载成功」——错误页本身对用户可见，配合常驻降级操作即可满足 spec FR-006。Tier 2（已授权站点）content script 在成功加载的页面内运行并回报，N 秒内无回报即可判定「疑似无法嵌入」并显示降级提示。
- **替代方案**: 服务器代理/远程渲染（引入登录态与安全问题，已在头脑风暴否决）；仅普通标签页（丧失侧栏核心价值，否决）。

## R3 iframe 导航/标题追踪：双层模型（关键修正）

- **决定**: `webNavigation` API 以 tabId 为作用域，**不覆盖扩展侧栏页内的 iframe**，不可用于本项目。改用双层模型：
  - **Tier 1（默认，无 host 权限）**: 监听 iframe 元素 `load` 事件，仅知道「发生了导航」，URL/标题未知 → 状态标记「可能未同步」，前进/后退使用扩展自维护的 URL 历史栈。
  - **Tier 2（任一授权开启后）**: 该精确来源获得 host 权限后，动态注册 `all_frames` content script（`browser.scripting.registerContentScripts`），在 iframe 内读取自身 `location.href` / `document.title`、监听 `popstate` 与 history API 变化并回报，实现 URL/标题/SPA 导航的完整追踪。
- **理由**: 已核实 MDN `webNavigation` 全部事件（onCommitted / onHistoryStateUpdated / onErrorOccurred 等）均按 tab 分发；侧栏页不是 tab。content script 注入跨源 iframe 后可读取本帧 DOM（不受同源限制），是浏览器允许的唯一完整追踪途径；其依赖 host 权限，与授权模型天然契合。spec FR-020/FR-021 的「尽力追踪 + 不确定状态」即由此双层模型兑现。
- **替代方案**: webNavigation 全量追踪（不适用，否决）；postMessage 要求目标网站配合（不通用，否决）。

### R3 spike 结论（T055 实测，2026-09-29 补记）

**判定：`ineffective`（Firefox 侧 Tier 2 不成立）—— 但结论的适用范围有明确边界，不可外推。**

实测环境：Playwright 的 Firefox 构建 `firefox-1543`（Firefox 155），无系统 Firefox 可装扩展。经逐条实测确定的可执行路径：**`web-ext run` 能把扩展真正装入该 Firefox 并让后台脚本执行**（Playwright 的 Firefox 型 `launchPersistentContext` 不接受 Chromium 的 `--load-extension`；把 XPI 放进 profile 的 `extensions/` 也无效，因为 Playwright 覆写了 `extensions.enabledScopes`）。观测通道：探针扩展在自己的扩展页里插入指向夹具服务的 iframe，由被注入脚本向服务端自报命中（扩展读不到跨源 iframe 的 DOM，请求是唯一不受同源策略影响的证据）。

| 观测项 | 结果 |
|--------|------|
| 后台脚本执行 | ✅ 正常（顶层与异步探针均有回报） |
| `scripting` API 可用 | ✅ 存在（`typeof browser.scripting === 'object'`） |
| `registerContentScripts` | ✅ 接受注册；`getRegisteredContentScripts()` 回读确认 `allFrames: true`、`runAt: 'document_idle'`、`world: 'ISOLATED'` 均已登记 |
| 扩展页内 iframe 注入 | ❌ 无命中（`iframe-loaded` 已确认 iframe 确实载入，排除"无内容可注入"的假阴性） |
| 普通标签页（非扩展页）注入 | ❌ 同样无命中 —— 说明**不是"不注入扩展页"这一条限制，而是该环境下动态注册的脚本根本没在已打开的页面中执行** |

**结论的适用范围（重要）**：上述判定**只在"注册完成后新打开的页面"这一时序下成立**。本次观测未覆盖"先打开页面、再注册脚本并 reload"的时序；也未在标准（非 Playwright 定制）Firefox 上验证。因此不能据此断言"Firefox 平台的 Tier 2 一定不可行"，只能断言"本机可用的 Firefox 构建 + web-ext 路径下，动态注册未能注入已打开的页面"。

**对实现的处置**：T056 的实现**不假设任何一端必然成功**，把可用性做成运行时可探测 —— `createContentScriptPort` 检查 `scripting.*` 是否存在，注册抛错即返回 false，能力状态如实退回 Tier 1 的「地址可能未同步」（FR-021）。该降级路径由 `tests/unit/content-scripts.test.ts` 的 20 项单测覆盖，不依赖浏览器实测。**Chrome 侧的 Tier 2 已由 T041 端到端证实可用**（SPA 页面 URL 变化被上报），因此双端策略是：Chrome 走完整 Tier 2，Firefox 若探测失败则自动落 Tier 1 不确定态。

**顺带发现的两个真实问题（已修）**：
1. **跨源 POST 的 CORS 预检**：探针向夹具服务发 `content-type: application/json` 的 POST 时，浏览器先发 OPTIONS 预检；夹具服务原先不处理 OPTIONS，导致真实 POST 从未发出 —— 表现为"探针静默无回报"，极易误判为"后台没执行"。夹具服务已补 `access-control-allow-*` 与 OPTIONS 处理。这条对任何"扩展页跨源上报"的实现都有参考价值。
2. **Firefox 清单的两个真实兼容性问题**（`web-ext lint` 报错，已修）：`declarativeNetRequestWithHostAccess` 与 `declarativeNetRequest` 在 Firefox 上**都不能作为 `optional_permissions`**（只能在 `permissions` 里），且 `optional_host_permissions` 需要 `strict_min_version: 128.0`（原写 115 会告警）。修正后 `web-ext lint` 对 `dist/firefox` 为 **0 error / 0 warning**。Firefox 的 UA 授权因此改为"API 权限随安装声明、host 权限仍按来源按需申请"——单独持有 DNR API 权限不足以修改任何请求（没有 host 权限就没有可命中的 `requestDomains`），不构成越权。

## R4 新窗口请求处理

- **决定**: Tier 1 不拦截，`target="_blank"` 由浏览器在普通新标签页打开（即 spec 的降级行为）；Tier 2 content script 捕获点击与 `window.open()`，经 runtime 消息请求扩展内新建标签页，失败时回退 Tier 1。
- **理由**: 扩展页内 iframe 的 `_blank` 导航在 Chrome 中默认开新浏览器标签页，不丢失用户操作，满足 spec FR-023/FR-040 的降级要求；content script 拦截是唯一能在页内识别新窗口意图的手段。
- **替代方案**: `webNavigation.onCreatedNavigationTarget`（tab 作用域，不适用）；一律阻止（破坏工作流，否决）。

## R5 真实移动 User-Agent：最佳努力改写

- **决定**: 默认仅移动视口；用户按精确来源授权后：
  - Chrome: `declarativeNetRequest` `modifyHeaders`（action `set`）改写 `User-Agent`，需要 `declarativeNetRequestWithHostAccess` 权限 + 该来源的 host 权限；规则按来源动态注册/注销。
  - Firefox: 优先同一 DNR 路径（FF113+ 支持 `modifyHeaders`），失败回退 `webRequest.onBeforeSendHeaders`（blocking）改写。
  - 两端差异收敛在适配层，以「能力探测结果」而非浏览器嗅探驱动；不支持时状态显示「已降级为移动视口」。
- **理由**: 已核实 MDN `ModifyHeaderInfo`：DNR 支持请求头 `set` 操作（`append` 有受限头列表，`set` 模型存在）；UA 字符串按主流移动浏览器模板生成。spec FR-007/FR-010 要求明确区分「视口模拟」与「真实 UA」，UI 以能力状态呈现。
- **风险与验证**: Chrome 对 `User-Agent` 头 `set` 的具体放行范围需实现期 spike 验证（构建最小规则实测）；spike 失败即固定降级为视口模式，不影响其余功能。
- **替代方案**: 全局 UA 改写（权限过大，已否决）；`userAgentData` 客户端提示（服务器采纳率低，仅作补充手段）。

### R5 spike 结论（T036 实测，2026-09-29 补记）

**判定：`effective` —— DNR `modifyHeaders.set User-Agent` 对扩展侧栏页内 iframe 的子框架请求确实生效。**

实测环境：Chrome for Testing 153.0.8010.12（Chromium 153 内核），真实加载未打包扩展（`dist/chrome` 及其权限静态声明变体），通过侧栏扩展页内动态插入的 iframe 请求夹具服务 `http://127.0.0.1:8919/echo-ua`，由服务端 `/echo-ua/last` 回读实际收到的 `User-Agent`。选择服务端回读而非读取 iframe DOM，是因为扩展页无法跨源读取 iframe 内容，服务端记录是唯一不受同源策略影响的证据通道。脚本与完整证据见 `scripts/spike-dnr-ua.ts` 与 `.playwright-mcp/t036/report.json`。

| 轮次 | 权限配置 | `updateSessionRules` | 服务端收到的 UA |
|------|----------|----------------------|------------------|
| A（真实产物，可选权限未授予） | `declarativeNetRequestWithHostAccess` 仅在 `optional_permissions` | **API 不存在**（`chrome.declarativeNetRequest` 为 `undefined`） | 浏览器原生：`Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/153.0.0.0 Safari/537.36` |
| B（spike 变体，权限静态声明） | 该权限提入 `permissions` + `host_permissions: ["http://127.0.0.1:8919/*"]` | 成功，规则被接受 | 改写后：`Mozilla/5.0 (Linux; Android 14; Pixel 8) … Chrome/127.0.0.0 Mobile Safari/537.36`（与目标串完全一致） |

**两条对实现有直接影响的发现**：

1. **可选权限未授予时，`chrome.declarativeNetRequest` 整个命名空间都不存在**，不是"存在但调用报错"。因此能力探测必须把"API 不存在"与"API 存在但规则被拒"分开判定，分别落到 `unsupported` 与 `degraded`（FR-029 要求区分浏览器不支持与实现了但失败）。
2. **`resourceTypes: ["sub_frame"]` + `requestDomains: [hostname]` 的条件组合足以命中扩展页内的 iframe 请求**，无需 `initiatorDomains`、无需顶层 `main_frame` 规则。这验证了 contracts/manifest-permissions.md「DNR 规则策略」一节的规则条件设计可直接照用。

**T037 因此采取的实现路径**：实现真实 DNR 会话规则路径（而非降级为纯视口模式）。规则按 `originKey → ruleId` 映射管理；`permissions.contains` 复核失败 → `unauthorized`；`updateSessionRules` 不可用 → `unsupported`；规则注册抛错或事后核对未生效 → `degraded`；三种情况 UI 均如实显示，绝不把移动视口标成真实 UA。

## R6 登录状态复用：检测 + 自然携带，不搬运 Cookie 值

- **决定**: 授权后申请 `cookies` 权限 + 该来源 host 权限，用途限于：(1) 读取该来源 Cookie 的**存在性**用于状态显示（「检测到会话 / 未检测到」）；(2) 在界面上解释复用失败原因。iframe 请求是否携带 Cookie 完全由浏览器按 SameSite、第三方 Cookie、分区策略决定，扩展不读取、不复制、不存储 Cookie 值；撤销授权时只撤销权限与标记，**不删除用户 Cookie**。
- **理由**: 已核实 MDN 第三方 Cookie 与 SameSite 文档：跨站 iframe 中 `Lax/Strict` Cookie 不发送，`None; Secure` 依赖浏览器第三方 Cookie 策略与分区；复制 Cookie 值既改变不了这些规则，又制造凭据泄漏面。存在性检测足以支撑 spec FR-012 的「尽力复用 + 状态可见」。
- **替代方案**: Cookie 值复制/重写（无效且高危，否决）；全局 cookies 权限（权限过大，否决）。

## R7 权限模型：按需申请、即时撤销

- **决定**: 基础权限仅 `storage`（+ Chrome `sidePanel`）；可选能力在用户在站点设置中开启对应开关时，通过 `browser.permissions.request` 按精确来源申请 host 权限及对应 API 权限；关闭开关时 `permissions.remove` 立即撤销并清理授权标记。启动时与每次使用前用 `permissions.contains` 校验，外部撤销自动回归降级态。
- **理由**: spec FR-010/FR-013/FR-030/FR-035；Chrome 可选 host 权限按 origin pattern 申请，正好匹配「精确来源」授权粒度（注意 Cookie 本身不按端口隔离，见 spec 假设）。
- **替代方案**: 安装时申请全部（权限解释差、违反最小权限，否决）。

## R8 会话存储

- **决定**: `browser.storage.local`，键 `session:v1` 与 `sites:v1`；每标签页历史上限 100 条（spec FR-015）；写入防抖；读取时逐条校验，损坏记录粒度化丢弃。
- **理由**: 20 标签页 × 100 URL ≈ 2000 条 ≈ 300–500KB，远低于配额（Chrome MV3 约 10MB / Firefox 约 5MB）；MV3 Service Worker 无常驻状态，所有持久态必须落 storage（宪法 III）。
- **替代方案**: IndexedDB（本项目数据量无必要，增加复杂度，YAGNI 否决）；`storage.session`（不满足跨浏览器重启恢复，否决）。

## R9 工具链与测试

- **决定**: TypeScript（strict）+ esbuild 打包 + webextension-polyfill；Vitest 单元/集成测试；Playwright（Chromium 持久化上下文加载未打包扩展）做 E2E；Firefox 用 `web-ext run` 做冒烟与手动验收清单。双份 manifest 由构建脚本从模板生成。
- **理由**: 依赖最少、配置显式、构建产物即发布包，符合宪法 I（KISS）与项目元信息「TypeScript + 打包器」。esbuild 对多入口（background/sidebar/content）配置直接。
- **替代方案**: WXT / CRXJS（框架封装重、Firefox 支持不稳，否决）；webpack（过重，否决）；Jest（与 esbuild 生态重复，Vitest 更轻）。

## R10 UI 技术与可访问性

- **决定**: 无框架的原生 TypeScript 视图模块（每视图一个职责单一的模块）；悬停菜单按 ARIA menu 模式实现（hover + click + focus/Enter 打开，Esc/外部点击关闭）；外部数据（标题/URL/错误）一律 `textContent` / 属性赋值，禁止 `innerHTML`。
- **理由**: 侧栏 UI 规模有限（网站列表、标签栏、菜单、降级页），引入框架得不偿失（宪法 I / YAGNI）；安全红线要求不渲染外部 HTML（spec FR-034）。
- **替代方案**: React/Vue（增加构建复杂度与包体，否决）。

## 遗留验证项（进入 tasks）

1. Chrome DNR `set User-Agent` 对扩展页内 iframe 请求的生效范围 spike（R5）。
2. Firefox `scripting.registerContentScripts` 在扩展页 iframe 的注入行为 spike（R3 Tier 2）。
3. 两项 spike 均失败不影响 Tier 1 功能交付，仅收窄 Tier 2 能力面。
