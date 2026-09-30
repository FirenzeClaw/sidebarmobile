# Quickstart 验证指南：侧栏移动浏览器

**日期**: 2026-09-29 | **关联**: [spec.md](spec.md) 成功标准 · [contracts/](contracts/)

本指南定义端到端验收流程。命令与 `package.json` scripts 及 `scripts/verify-*.ts` 保持一致（实现完成后已对齐）。

## 前置条件

- Node 24（本机 nvm `current`）+ npm
- Chrome（支持 `sidePanel` 的版本）与 Firefox（≥128，`optional_host_permissions` 与 `data_collection_permissions` 需要）
- 依赖安装：`npm install`

## 构建与运行

| 目的 | 命令 | 预期产物 |
|------|------|----------|
| 类型检查 | `npm run typecheck` | 无错误 |
| 单元/集成测试 | `npm test` | Vitest 全绿（当前 529 项） |
| 构建双端包 | `npm run build` | `dist/chrome/` 与 `dist/firefox/`（各含对应 manifest） |
| 夹具站点 | `npm run fixtures` | 六类被测页面，端口 8919 |
| Firefox 运行 | `npm run run:firefox` | `web-ext run` 启动并加载 `dist/firefox` |
| Firefox 清单校验 | `npx web-ext lint --source-dir dist/firefox` | 零 error / warning / notice |

真实浏览器检查点（脚本自带夹具服务，端口 8921，跑完自动释放端口与浏览器进程）：

| 脚本 | 覆盖 | 断言数 |
|------|------|--------|
| `node --experimental-strip-types scripts/verify-t029.ts` | US1 添加网址与多标签浏览 | 40 |
| `node --experimental-strip-types scripts/verify-t041.ts` | US2 移动视口与 UA 授权 | 27 |
| `node --experimental-strip-types scripts/verify-t048.ts` | US3 登录复用授权 | 18 |
| `node --experimental-strip-types scripts/verify-t059.ts` | US4 嵌入降级与导航追踪 | 21 |
| `node --experimental-strip-types scripts/verify-t066.ts` | US5 会话恢复 | 27 |
| `node --experimental-strip-types scripts/verify-t073.ts` | US6 菜单三通道与标签压力 | 28 |

> 进程纪律：这些脚本必须在结束时终止自己启动的服务与浏览器进程。禁止以后台常驻方式启动夹具服务。

Chrome 手动加载：`chrome://extensions` → 开发者模式 → 加载已解压 → `dist/chrome`。
Firefox 手动加载：`about:debugging` → 临时载入附加组件 → `dist/firefox/manifest.json`。

## 验收场景（映射成功标准）

| # | 场景 | 步骤 | 预期 | 覆盖 |
|---|------|------|------|------|
| 1 | 添加并打开 | 添加 `https://example.com` | 保存入列表并立即在新标签页打开 | SC-001/SC-002 |
| 2 | 非法地址 | 输入 `javascript:alert(1)`、`file:///x` | 拒绝并说明原因，列表/历史无新增 | SC-001 |
| 3 | 多标签页 | 打开 3 个站点并互相切换 | 各标签独立 URL/历史/加载态 | SC-003 |
| 4 | 移动视口默认 | 打开未授权站点 | 移动视口 + 状态不显示「真实 UA」 | SC-004/SC-005 |
| 5 | UA 授权 | 站点设置开启真实移动 UA 并批准权限 | 尝试真实 UA 并显示实际结果；拒绝则回弹降级 | SC-005 |
| 6 | 登录复用 | 开启登录复用；再用受 Cookie 限制页面 | 允许时不需重登；受限时显示受限与重登/普通标签页操作 | SC-006 |
| 7 | 禁止嵌入 | 添加发送 `X-Frame-Options` 的页面 | 侧栏内降级层 + 两个普通标签页操作，不自动跳离 | SC-009 |
| 8 | SPA/跨源导航 | 在可嵌入 SPA 内点链接 | 可观察时更新地址/标题/历史；不可观察时标「可能未同步」 | SC-005/SC-009 |
| 9 | 新窗口请求 | 点击 `target="_blank"` 链接 | 转扩展新标签或普通标签页，操作不丢失 | SC-009 |
| 10 | 新来源自动入列 | 导航到未添加来源 | 自动加入网站列表且不覆盖已有入口 | SC-001 |
| 11 | 会话恢复 | 关浏览器重开 | 恢复标签/活动标签/设置/历史（≤100 条）；已关闭标签不恢复 | SC-007 |
| 12 | 权限撤销 | 关闭开关 + 浏览器设置里外部撤销 | 权限即时撤销、标记清理、状态回归降级 | SC-005/SC-009 |
| 13 | 键盘/触摸菜单 | 仅键盘与仅触摸各操作一遍图标菜单 | 可开可关可触发，均有可访问名称 | SC-010 |
| 14 | 20 标签页压力 | 开满 20 标签 | 标签列表可用、活动标签可见、操作不遮挡内容 | SC-003 |
| 15 | 敏感数据 | 检查存储内容 | 无 Cookie 值/密码/表单/页面内容 | SC-012 |
| 16 | 双端一致 | Chrome 与 Firefox 各跑 1~13 | 核心流程均完成；平台差异有明确状态 | SC-011 |

## 测试站点需求（E2E 夹具）

`scripts/fixture-server.ts` 提供七类页面：`/health`（探活）、`/embeddable`（可嵌入，含站内链接与 `target=_blank`）、`/xfo`（`X-Frame-Options: DENY`）、`/csp`（`frame-ancestors 'none'`）、`/login`（可设 `SameSite=None; Secure` 会话）、`/cross-origin`（跨源跳转）、`/spa`（`history.pushState`）、`/blank-target`（`_blank` 与 `window.open`）。对应 spec FR-037。

## 完成判定

- 六个检查点脚本全部通过（合计 161 项断言），其中：
  - US1–US6 的核心流程在 Chromium 自动化覆盖；
  - Firefox 侧由 `web-ext lint`（零 error/warning/notice）+ 运行时能力探测覆盖，**桌面手动逐项勾选尚未执行**（需人工点击权限对话框），已记为待办；
- `npm run typecheck`、`npm test`、`npm run build` 全部通过；
- 任一能力降级时 UI 状态与 [ui-states.md](contracts/ui-states.md) 徽章表一致。
