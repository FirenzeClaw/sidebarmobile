# 契约：运行时消息协议

**版本**: v1 | **日期**: 2026-09-29 | **关联**: [data-model.md](../data-model.md) · spec FR-033/FR-034、宪法 III

侧栏页、后台（Service Worker / 事件页）、content script 之间的全部消息。收发两端必须按本文档校验形状，不信任发送方。

## 总约定

- 每条消息含 `type`（判别字段）与 `payload`；未知 `type` 一律忽略并记录调试日志。
- 响应统一信封：`{ ok: true, data: T }` 或 `{ ok: false, error: { code, message } }`；`message` 面向用户可读，不含堆栈。
- `originKey` 必须能解析为合法 OriginKey（§data-model 1）；`url` 必须通过 URL 策略（http/https）。
- content script 消息只接受来自本扩展注册的脚本上下文；URL/标题字段按纯文本处理。

## sidebar → background

### `permissions.apply-grant`

**侧栏已完成权限申请**，把浏览器的原生结论上报给后台，请后台复核并落地授权副作用。

```json
{ "type": "permissions.apply-grant", "payload": { "originKey": "https://example.com", "grant": "ua", "outcome": "granted" } }
```

- `grant`: `"ua" | "cookie"`（彼此独立，FR-009/FR-011）。
- `outcome`: `"granted" | "denied" | "unsupported"` —— **浏览器给出的原生结论**，由侧栏在用户手势链内调用 `permissions.request` 后原样上报；未知取值一律拒绝（不收窄成默认值）。
- 成功 `data`: `{ "granted": true }`；用户拒绝或浏览器不支持：`{ ok: true, data: { "granted": false, "reason": "denied" | "unsupported" } }`（属正常降级，非错误）。

**为什么申请不在这里做（2026-09-30 修正，缺陷"开关点不动"）**：`permissions.request()` 必须在**用户手势的直接调用链**中执行。侧栏点击 → `runtime.sendMessage` → 后台申请，这条跨进程往返会让手势失效，Chromium **静默**返回 false（不弹对话框、不报错），用户看到的现象是开关点不动。

因此本消息的语义是**"我申请完了，结论是这个，请你复核后落地"**，不是"请你申请"：

| 阶段 | 执行方 | 动作 |
|------|--------|------|
| 申请权限 | **侧栏**（手势链内，点击后的第一个 `await`） | `permissions.request(permissionSpecFor(originKey, grant))` |
| 复核 + 落地 | 后台 | `permissions.contains(同一份规格)` → 写授权标记 → 注册/注销 DNR 规则与 content script → 返回能力状态 |

**后台必须复核，不信任侧栏声称**（宪法 III）：`contains` 按**与申请同一份** `permissionSpecFor` 推导的整批权限（API 权限 + 该来源 host pattern）检查。复核不通过时一律按 `denied` 落地，即便上报的是 `granted` —— 挡掉三类真实情形：对话框尚被用户挂着就回报成功、只拿到 API 权限而未拿到该来源 host 权限、上报与复核之间权限被外部撤销（FR-030）。

**顺序不可颠倒**：必须在权限结论确定**之后**才落规则。反过来会在权限对话框还开着时就注册 DNR 规则 —— 用户随后点拒绝，规则却已生效。

> **历史**：本消息原为 `permissions.request-grant`，语义是"请后台申请权限"。该语义是上述缺陷的直接原因，已随修复删除；保留旧名会误导读者以为申请仍发生在后台。

### `permissions.revoke-grant`

```json
{ "type": "permissions.revoke-grant", "payload": { "originKey": "https://example.com", "grant": "cookie" } }
```

- 立即撤销对应可选权限并返回最新 CapabilityState。

### `capabilities.query`

```json
{ "type": "capabilities.query", "payload": { "originKey": "https://example.com" } }
```

- `data`: CapabilityState（§data-model 6）。每次使用前现算，含 `permissions.contains` 复核。

## content → background（Tier 2，已授权来源）

### `frame.report`

iframe 内导航/标题上报。

```json
{ "type": "frame.report", "payload": { "url": "https://example.com/a", "title": "页面标题", "navKind": "load" } }
```

- `navKind`: `"load" | "history" | "hash"`（SPA 用 history/hash）。
- 校验：url 必须属于已注册该脚本的 originKey，否则丢弃。
- 标题上限 512 字符（`shared/frame-report-spec.ts` 的 `MAX_TITLE_LENGTH`）：后台与侧栏**共用同一实现**，因为侧栏是最终把它写进状态与存储的一侧，两侧规则不同就会有人绕过清洗。
- **标签归属的歧义边界**：后台与侧栏都按"无歧义才认"处理 —— 同一来源只有一个标签时归属明确；多个标签时只有上报地址（忽略 hash）恰好命中一个才认；仍然无法区分则**丢弃**该上报（宁可暂停该来源的 Tier 2 推进，也不把 A 标签的页面写进 B 标签的历史栈）。代价是这种情形下顶栏如实显示「地址可能未同步」（FR-021）。

### `frame.open-request`

页内 `target="_blank"` / `window.open()` 的新窗口意图。

```json
{ "type": "frame.open-request", "payload": { "url": "https://other.com/x", "sourceUrl": "https://example.com/a" } }
```

**响应语义（关键）**：接收方必须回 `{ "handled": true | false }`，声明自己是否接手。

- `handled: true` — **侧栏**已在扩展内新建标签页（主路径，FR-023），content script 不再另开；
- `handled: false` / 无响应 / 形状不符 — 无人接手，content script 退回浏览器的普通新标签页（FR-040，不得静默阻止导航）。

**恰好一个结果**：一次点击只允许产生一个标签页。判定由接收方给出而不是发送方推断 ——
发送方无从知道侧栏是否打开、是否在追踪该来源。后台**刻意不回应**该消息（它不作为落地方），
把响应留给侧栏；两边都回应或都不回应都会破坏这条契约（终审 D1 的双开缺陷正是两边各自开了一个）。

**两条路径的能力不同，如实记录**：

- **点击路径可以精确转换**：点击可取消，content script 同步 `preventDefault()` 后再上报，因此浏览器不会另开；没人接手时补开一次普通标签页。
- **`window.open` 路径只能尽力而为**：该 API 同步且返回值被站点立刻使用，没有可取消的钩子。实现选择让原调用照常执行，**仅在返回 null**（被弹窗策略拦下等）时才上报，让侧栏接手。因此 `window.open` 的转换不保证成功，这属于 research R4 已记录的取舍，不是缺陷。

- 归属校验按 `sourceUrl` 的来源判定，且该来源必须处于 Tier 2 追踪（已授权）；未授权来源的脚本本就不该存在。
- 目标 URL 必须是 http(s)：其他协议交给浏览器自身处理，不在侧栏内打开。

## background → sidebar（事件推送）

### `capabilities.changed`

**触发：`permissions.onRemoved`**（浏览器侧权限被撤销），由后台现算状态后推送。

```json
{ "type": "capabilities.changed", "payload": { "originKey": "https://example.com", "state": { "ua": "degraded", "cookie": "unauthorized", "navigation": "partial", "embed": "unknown" } } }
```

- 这是 FR-030「外部撤销后自动回归降级态」的通知渠道：没有它，用户在浏览器设置里撤销权限后，侧栏会一直显示旧状态（徽章写着「真实移动 UA」而规则已失效）。
- 后台同时注销该来源的 content script 注册（host 权限没了，脚本已无法注入）。
- 推送失败不影响正确性：侧栏每次查询都现算，`capabilities.changed` 只是及时性优化。

## 已移除的消息类型

以下类型曾在契约中声明但**全项目没有任何生产者或使用者**，已从 `shared/messages.ts` 删除（终审 [建议修改]）。保留"声明了但没人发"的条目会让协议清单与实际能力不一致：

| 类型 | 移除理由 |
|------|----------|
| `tabs.open-external` | 侧栏自己经 `adapters/browser-api.ts` 的 `tabsApi.openExternal` 完成，无需绕后台 |
| `ua.sync-rules` | DNR 规则的注册/注销已包含在 `permissions.apply-grant` / `permissions.revoke-grant` 的执行路径中 |
| `session.dirty` | 会话写入发生在侧栏进程内，结果由 `session-store` 的写入订阅（FR-032）直接分发，不经消息通道 |

此外 `permissions.request-grant` 已**改名**为 `permissions.apply-grant`（语义一分为二，见上文）：
申请权限移回侧栏的手势链内，后台只复核并落地。这不是"新增一条并行通道"，而是同一件事的
责任重新划分 —— 因此旧名不保留为别名，否则会出现两个名字指向同一语义、其中一个的实现路径
违反浏览器约束。

## 错误码

| code | 含义 | 用户可见文案方向 |
|------|------|------------------|
| `invalid-message` | 形状校验失败 | 不提示（记录日志） |
| `invalid-url` | URL 策略拒绝 | 「该地址不被支持」 |
| `permission-denied` | 用户拒绝授权 | 「未授权，已使用降级模式」 |
| `capability-unsupported` | 浏览器不支持 | 「当前浏览器不支持该能力」 |
| `storage-failed` | 存储失败/配额 | 「会话可能无法完整恢复」 |
