# 契约：存储结构

**版本**: v1 | **日期**: 2026-09-29 | **关联**: [data-model.md](../data-model.md) · spec FR-015~FR-018/FR-031/FR-032

存储后端：`browser.storage.local`。MV3 Service Worker 无常驻状态，启动时读取、变更时防抖写入。

## 键空间

| 键 | 内容 | 结构来源 |
|----|------|----------|
| `session:v1` | SessionSnapshot（标签页集合 + 活动标签） | data-model §5 |
| `sites:v1` | `{ version: 1, sites: SiteEntry[] }`（网站列表） | data-model §2/§4 |
| `site-settings:v1` | `{ [originKey]: { displayMode, uaGrant, cookieGrant } }` | data-model §4 |
| `meta:v1` | `{ schemaVersion: 1, createdAt, lastSavedAt }` | 迁移与诊断 |

- **设置的唯一权威位置是 `site-settings:v1`**：`SiteEntry` 上仍保留一个 `settings` 字段（读取时校验、
  新建时填默认值），但没有任何代码修改它 —— 站点设置的全部读写都走 `site-settings:v1`
  （`SiteSettingsStore` / `loadSiteSettings`）。这样设置可以存在于尚未加入网站列表的来源上
  （例如从网页导航抵达时直接改了显示模式）。
- 版本号内嵌在键名与 `version` 字段；结构演进新增 `*:v2` 并做一次性迁移，旧键确认迁移成功后删除。
- 禁止写入：Cookie 值、密码、表单输入、页面 HTML/脚本状态（FR-018/FR-033）。

## 写入者归属（FR-038/FR-039，终审 A1/A2）

`site-settings:v1` 是**两个写入者共享一条键**，因此按**字段**划分归属，不允许整份覆盖：

| 字段 | 唯一写入者 | 另一侧的职责 |
|------|------------|--------------|
| `displayMode` | 侧栏（用户操作） | 后台不碰 |
| `uaGrant` / `cookieGrant` | 后台（授权操作 + 权限复核） | 侧栏只旁观，**以存储为准** |

- **侧栏写入必须合并而非覆盖（A2）**：逐来源读回存储现值，`displayMode` 用传入值，
  两项授权标记用**存储当前值**。若侧栏把自己的整份内存快照覆盖上去，会把后台刚写的 `granted`
  抹成 `never` —— 表现为「用户点了允许、规则也生效了，重启后授权却没了」，直接违反 FR-039。
  存储里有而本次未传的来源原样保留，避免"只提交一个来源"把别的来源删掉。
- **侧栏必须订阅外部写入（A1）**：授权标记的唯一写入者是后台，两侧不在同一上下文。
  订阅通道是 `browser.storage.onChanged`（经 `adapters/browser-api.ts` 的 `createStorageArea().onChanged`
  接入），**不依赖任何自造消息**。事件到达后侧栏把存储里的权威值镜像回内存（授权标记以存储为准，
  显示模式以本地为准），界面开关因此能如实反映"用户点了允许"。
  - 镜像自身会触发一次设置写入，进而又产生存储变更事件。回路由 `SiteSettingsStore.restore`
    的**内容比对**终止：第二圈发现内容一致即返回，不再通知。
- `permissions.contains` 的复核仍是唯一的"能力是否真的可用"判据（FR-030）；存储里的标记表达的是
  **用户意愿**，两者不可互相替代。

## 容量预算

- 估算上界：20 标签页 × 100 条历史 × ~200B ≈ 400KB；网站列表 200 条目 × ~500B ≈ 100KB。
- 远低于配额（Chrome MV3 ≈10MB / Firefox ≈5MB）；写入前估算字节数，超过 80% 配额时先裁剪非活动标签页的最旧历史再写入。

## 读取校验（FR-031）

1. 顶层形状不符 → 该键视为空（`tabs: []` / `sites: []` / `settings: {}`），不阻塞启动。
2. 逐条校验：URL 必须为 http/https、OriginKey 可解析、historyIndex 在界内、activeTabId 必须存在。
3. 单条不合格 → 丢弃该条并计数；其余照常加载。设置的字段级非法回落默认值（不丢弃整条）。
4. 校验结果写入调试日志（不含 URL 以外的页面数据）。

## 写入策略

- 防抖：导航/标题高频变化合并为 300ms 内一次写入。
- 关闭标签页：立即写入（FR-016 的删除语义不能因防抖丢失）。
- 写入失败：重试一次；仍失败则**由进程内的写入订阅**（`SessionStore.onWriteResult`）通知界面，
  提示但保持当前内存态可用（FR-032）。
  - 此前契约写的是"发 `session.dirty` 消息"。该消息类型已移除：会话写入本就发生在侧栏进程内，
    结果可以直接分发，绕一圈消息通道没有任何收益（见 runtime-messages.md §已移除的消息类型）。
- **来源侧的上限**：来自第三方页面的标题按 `shared/frame-report-spec.ts` 的 `MAX_TITLE_LENGTH`
  截断，侧栏写状态前也必须过这一层（否则清洗只保护了后台的路径，超长标题仍会进入存储）。

