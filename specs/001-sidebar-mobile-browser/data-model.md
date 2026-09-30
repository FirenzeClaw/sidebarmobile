# Phase 1 数据模型：侧栏移动浏览器

**日期**: 2026-09-29 | **关联**: [spec.md](spec.md) · [research.md](research.md)

实体来自 spec「Key Entities」。所有字段为持久化契约（存于 `browser.storage.local`，见 [contracts/storage-schema.md](contracts/storage-schema.md)）；运行时能力状态不持久化。

## 1. 精确来源 OriginKey

站点的身份键，用于归并网站条目、站点设置与授权。

| 字段 | 类型 | 校验规则 |
|------|------|----------|
| scheme | `"http" \| "https"` | 仅此两种（FR-002/FR-003） |
| host | string | 合法主机名或 IP，小写规范化 |
| port | number \| null | 默认端口（80/443）归一为 null |

- 序列化形式：`"https://example.com"` / `"https://example.com:8443"`。
- Cookie 实际作用域遵循浏览器规则，不按端口隔离（spec 假设，界面需明示）。

## 2. 网站条目 SiteEntry

| 字段 | 类型 | 校验规则 |
|------|------|----------|
| originKey | OriginKey | 唯一键 |
| title | string | 用户可编辑；默认取 host；渲染时按纯文本处理 |
| faviconUrl | string \| null | 仅 http/https/data 图片；加载失败回退默认图标 |
| entryPoints | EntryPoint[] | ≥1；首个为用户原始入口 |
| settings | SiteSettings | 见 §4 |
| addedBy | `"user" \| "navigation"` | 导航自动加入记为 navigation（FR-019） |
| createdAt / updatedAt / lastVisitedAt | ISO 8601 string | 必填 |

### EntryPoint

| 字段 | 类型 | 校验规则 |
|------|------|----------|
| url | string | 必须属于该 originKey 的 http/https URL |
| label | string \| null | 可选用户备注 |

- 规则：不同路径可共存（FR-005）；自动加入的新来源不覆盖已有用户入口（FR-019）。

## 3. 浏览标签页 BrowserTab

| 字段 | 类型 | 校验规则 |
|------|------|----------|
| tabId | string (UUID) | 生成后不可变 |
| originKey | OriginKey | 当前 URL 的来源；随导航更新 |
| currentUrl | string | http/https；与 history[historyIndex] 一致 |
| title | string \| null | Tier 2 上报；Tier 1 为 null |
| history | HistoryEntry[] | 长度 ≤ 100；超出淘汰最旧（FR-015） |
| historyIndex | number | 0 ≤ index < history.length |
| loadState | `"idle" \| "loading" \| "loaded" \| "failed" \| "blocked"` | 见 §7 状态机 |
| createdAt | ISO 8601 string | 必填 |

### HistoryEntry

| 字段 | 类型 | 校验规则 |
|------|------|----------|
| url | string | http/https |
| title | string \| null | 可选 |
| visitedAt | ISO 8601 string | 必填 |

- 不持久化：页面内容、表单输入、密码、Cookie 值、临时脚本状态（FR-018/FR-033）。

## 4. 站点设置 SiteSettings

| 字段 | 类型 | 校验规则 |
|------|------|----------|
| displayMode | `"mobile" \| "desktop"` | 默认 `mobile`；按精确来源保存（FR-008） |
| uaGrant | GrantState | 默认 `never`；与 cookieGrant 独立（FR-009） |
| cookieGrant | GrantState | 默认 `never`；与 uaGrant 独立（FR-011） |

### GrantState（授权标记，非能力成功态）

```text
never ──开启开关并批准权限──> granted
granted ──关闭开关/外部撤销──> revoked
revoked ──再次开启──> granted
```

- `granted` 仅表示「用户授权过且权限当前有效」，每次使用前以 `permissions.contains` 复核；失效自动转为 `revoked`（FR-030）。
- 不持久化「上次 UA 改写成功」之类的能力结果（FR-039）。

## 5. 会话快照 SessionSnapshot

| 字段 | 类型 | 校验规则 |
|------|------|----------|
| version | 1 | 结构演进时递增并迁移 |
| tabs | BrowserTab[] | 可为空数组 |
| activeTabId | string \| null | 必须指向 tabs 中存在的 tabId，否则置 null |
| savedAt | ISO 8601 string | 必填 |

- 网站列表存于独立键（`sites:v1`），不随会话快照增删（FR-017）。
- 标签页关闭即从此快照删除（FR-016）；全关后恢复显示网站列表主页。
- 恢复时逐条校验，坏记录粒度化丢弃（FR-031）。

## 6. 运行时能力状态 CapabilityState（不持久化）

每次打开/切换站点时由适配层现算：

| 能力 | 取值 |
|------|------|
| ua | `unknown \| unauthorized \| active \| degraded \| failed \| unsupported` |
| cookie | `unknown \| unauthorized \| available \| limited \| failed` |
| navigation | `tracked \| partial \| uncertain` |
| embed | `ok \| suspected-blocked \| failed \| unknown` |

- 映射规则：`unauthorized` = 对应 grant ≠ granted；`degraded` = 已授权但浏览器/网站不支持；`uncertain` = Tier 1 追踪。界面文案必须如实呈现（FR-029）。

## 7. 标签页加载状态机

```text
idle ──导航开始──> loading
loading ──加载完成──> loaded
loading ──网络错误──> failed
loading ──疑似 XFO/CSP 拦截──> blocked
loaded ──再次导航──> loading
failed/blocked ──重试/切换 URL──> loading
```

- `failed`/`blocked` 保留标签页与历史，显示降级操作（当前/新标签页打开），不自动离开侧栏（FR-006）。

## 关系总览

```text
SiteEntry 1───1 SiteSettings
SiteEntry 1───n EntryPoint
BrowserTab n───1 OriginKey（当前来源）
BrowserTab 1───n HistoryEntry
SessionSnapshot 1───n BrowserTab
```
