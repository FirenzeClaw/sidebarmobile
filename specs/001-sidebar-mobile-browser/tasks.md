---
description: "侧栏移动浏览器实现任务清单"
---

# Tasks: 侧栏移动浏览器

**Input**: Design documents from `/specs/001-sidebar-mobile-browser/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: 本项目宪法 II 强制 TDD（没有失败的测试就不写生产代码），spec FR-037 要求真实浏览器场景验收，因此测试任务为必选。

**Organization**: 按用户故事分组；每个故事独立完成、独立测试、独立交付。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 用户故事标签（US1~US6，对应 spec.md 优先级 P1~P6）
- 每个实现任务前的测试任务必须先写并确认失败（RED→GREEN）

## Path Conventions

单项目结构（plan.md）：`src/` 与 `tests/` 在仓库根；构建产物 `dist/chrome` 与 `dist/firefox`。

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 项目初始化与双端构建骨架

- [x] T001 创建 package.json：依赖 typescript/esbuild/vitest/playwright/web-ext/webextension-polyfill/@types/chrome/@types/firefox-webext-browser，scripts 含 typecheck/test/build/test:e2e/run:firefox（quickstart.md 命令契约）
- [x] T002 创建 tsconfig.json（strict、DOM+ES2022 lib、moduleResolution bundler、noUncheckedIndexedAccess）
- [x] T003 [P] 创建双端构建脚本 scripts/build.ts（esbuild 三入口 background/sidebar/content + manifest 分流输出 dist/chrome 与 dist/firefox）
- [x] T004 [P] 创建 Chrome 清单模板 src/manifests/manifest.chrome.json（side_panel、service_worker、基础权限 storage+sidePanel，contracts/manifest-permissions.md）
- [x] T005 [P] 创建 Firefox 清单模板 src/manifests/manifest.firefox.json（sidebar_action、background.scripts、基础权限 storage，不设 browser_style）
- [x] T006 创建入口骨架：src/sidebar/index.html、src/sidebar/app.ts、src/background/index.ts、src/content/frame-reporter.ts（可构建的空壳，含文件头注释）
- [x] T007 [P] 创建 Vitest 配置 vitest.config.ts 与浏览器 API mock tests/helpers/mock-browser.ts
- [x] T008 [P] 创建 Playwright 配置 playwright.config.ts 与夹具服务器 scripts/fixture-server.ts（六类页面：可嵌入/XFO 拦截/登录态/跨源跳转/SPA/target=_blank，FR-037）
- [x] T009 冒烟检查点：npm run build 后 dist/chrome 与 dist/firefox 均能在对应浏览器加载并打开空白侧栏

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 所有用户故事共享的核心基础设施

**⚠️ CRITICAL**: 本阶段完成前不得开始任何用户故事

- [x] T010 写失败单测：URL 策略（接受 http/https、拒绝特殊协议、规范化、原始输入保留）tests/unit/url-policy.test.ts
- [x] T011 实现 URL 策略 src/shared/url-policy.ts（使 T010 通过）
- [x] T012 [P] 写失败单测：精确来源键（协议/域名/端口、默认端口归一、序列化）tests/unit/origin-key.test.ts
- [x] T013 [P] 实现精确来源键 src/shared/origin-key.ts（使 T012 通过）
- [x] T014 [P] 写失败单测：消息协议校验（type 判别、originKey/url 校验、未知 type 忽略、错误信封）tests/unit/messages.test.ts
- [x] T015 [P] 实现消息协议类型与校验 src/shared/messages.ts（contracts/runtime-messages.md，使 T014 通过）
- [x] T016 写失败单测：会话存储（防抖写入、立即写入路径、损坏记录粒度丢弃、80% 配额裁剪）tests/unit/session-store.test.ts
- [x] T017 实现会话存储 src/shared/session-store.ts（contracts/storage-schema.md，使 T016 通过）
- [x] T018 实现数据模型类型 src/shared/types.ts（SiteEntry/EntryPoint/SiteSettings/BrowserTab/HistoryEntry/SessionSnapshot/CapabilityState/GrantState，data-model.md）
- [x] T019 实现浏览器 API 适配出口 src/adapters/browser-api.ts（webextension-polyfill 统一封装，业务代码禁止直接引用 chrome/browser 全局）

**Checkpoint**: 基础设施就绪，用户故事可开始

---

## Phase 3: User Story 1 - 添加网址并在侧栏标签页浏览 (Priority: P1) 🎯 MVP

**Goal**: 用户添加合法网址后保存入列表并立即在新标签页打开；多标签独立浏览、切换、关闭；关闭标签不随重启恢复

**Independent Test**: 添加两个网址 → 切换/关闭标签 → 重开扩展验证恢复（quickstart 场景 1-3）

### Tests for User Story 1

- [x] T020 [US1] 写失败单测：标签会话管理（创建/切换/关闭、历史栈 ≤100 淘汰、前进后退索引一致）tests/unit/tab-session.test.ts
- [x] T021 [P] [US1] 写失败单测：网站注册表（按 originKey 去重、入口路径共存、用户入口不被覆盖）tests/unit/site-registry.test.ts
- [x] T022 [US1] 写失败集成测试：添加 URL → 新标签打开 → 重载后恢复、已关闭标签不恢复 tests/integration/add-and-restore.test.ts

### Implementation for User Story 1

- [x] T023 [US1] 实现标签会话管理 src/sidebar/state/tab-session.ts（使 T020 通过，FR-014/FR-015/FR-016）
- [x] T024 [P] [US1] 实现网站注册表 src/sidebar/state/site-registry.ts（使 T021 通过，FR-004/FR-005）
- [x] T025 [US1] 实现网站列表视图（添加输入框 + 条目网格 + textContent 安全渲染）src/sidebar/views/site-list.ts 与 src/sidebar/index.html（FR-025/FR-034）
- [x] T026 [US1] 实现网页浏览视图（每标签一个 iframe 宿主、单视图切换、内容占满）src/sidebar/views/browser-view.ts 与 src/sidebar/app.ts（FR-006/FR-025）
- [x] T027 [US1] 实现基础导航条（前进/后退/刷新走扩展历史栈）src/sidebar/components/nav-bar.ts（FR-022）
- [x] T028 [US1] 接线会话持久化：变更防抖保存、启动恢复、关闭即删 src/sidebar/app.ts 调用 src/shared/session-store.ts（使 T022 通过，FR-016/FR-017）
- [x] T029 [US1] 手动检查点：Chrome 侧栏端到端验证 quickstart 场景 1-3

**Checkpoint**: US1 独立可用，MVP 达成

---

## Phase 4: User Story 2 - 在侧栏中获得移动端适配 (Priority: P2)

**Goal**: 默认移动视口；按精确来源保存移动/桌面模式；按需授权真实移动 UA，失败如实降级

**Independent Test**: 同一站点分别验证默认视口、UA 授权、桌面切换（quickstart 场景 4-5）

### Tests for User Story 2

- [x] T030 [US2] 写失败单测：站点设置（displayMode 默认 mobile、按来源持久、切换不影响其他来源）tests/unit/site-settings.test.ts
- [x] T031 [P] [US2] 写失败单测：能力状态计算（grant×权限复核×能力探测 → CapabilityState）tests/unit/capability-state.test.ts
- [x] T032 [US2] 写失败集成测试：权限适配（request/contains/remove、拒绝→降级、不抛异常）tests/integration/permissions.test.ts

### Implementation for User Story 2

- [x] T033 [US2] 实现站点设置 src/sidebar/state/site-settings.ts（使 T030 通过，FR-008/FR-038）
- [x] T034 [P] [US2] 实现能力状态计算 src/sidebar/state/capability-state.ts（使 T031 通过，FR-029，data-model §6）
- [x] T035 [US2] 实现权限适配 src/adapters/permissions.ts（使 T032 通过，FR-010/FR-035）
- [x] T036 [US2] Spike：实测 Chrome DNR set User-Agent 对扩展页 iframe 请求的生效范围 scripts/spike-dnr-ua.ts（research R5 遗留验证，结果写入 research.md）
- [x] T037 [US2] 实现 UA 改写适配 src/adapters/ua-override.ts（Chrome DNR 会话规则；Firefox DNR 优先、webRequest blocking 回退；能力探测收敛）
- [x] T038 [US2] 后台接线 permissions.request-grant 与 ua.sync-rules 消息处理 src/background/index.ts（contracts/runtime-messages.md）
- [x] T039 [US2] 实现站点设置 UI（移动/桌面切换、UA 开关、能力状态徽章）src/sidebar/components/site-settings.ts 与 src/sidebar/components/status-badge.ts（contracts/ui-states.md）
- [x] T040 [US2] 应用移动视口默认（视口尺寸/布局提示）src/sidebar/views/browser-view.ts（FR-007）
- [x] T041 [US2] 手动检查点：quickstart 场景 4-5（Chrome）

**Checkpoint**: US1+US2 均独立可用

---

## Phase 5: User Story 3 - 按站点复用登录状态 (Priority: P3)

**Goal**: 按精确来源授权登录复用；会话存在性检测与状态解释；关闭授权立即撤销且不动用户 Cookie

**Independent Test**: 登录型夹具页验证授权前/授权成功/受限/撤销四态（quickstart 场景 6、12）

### Tests for User Story 3

- [x] T042 [US3] 写失败单测：Cookie 检测适配（仅存在性、永不返回值、错误映射）tests/unit/cookie-insight.test.ts
- [x] T043 [US3] 写失败集成测试：授权流四态（未授权/成功/受限/撤销后清理）tests/integration/grant-flows.test.ts

### Implementation for User Story 3

- [x] T044 [US3] 实现 Cookie 检测适配 src/adapters/cookie-insight.ts（使 T042 通过，FR-012/FR-033，research R6）
- [x] T045 [US3] 后台接线 cookie grant 申请/撤销与 capabilities.changed 推送 src/background/index.ts（FR-013/FR-030）
- [x] T046 [US3] 站点设置 UI 增加登录复用开关与状态说明 src/sidebar/components/site-settings.ts（使 T043 通过）
- [x] T047 [US3] 实现即时撤销语义：撤销权限 + 清理标记 + 当前标签回降级刷新 src/adapters/permissions.ts 与 src/sidebar/state/capability-state.ts（FR-013）
- [x] T048 [US3] 手动检查点：quickstart 场景 6 与 12（Chrome）

**Checkpoint**: US3 独立可用，授权模型完整

---

## Phase 6: User Story 4 - 处理不可嵌入、新窗口和复杂导航 (Priority: P4)

**Goal**: 禁止嵌入侧栏内降级；双层导航追踪（Tier 1 不确定态 / Tier 2 content script 完整上报）；新窗口转扩展标签；新来源自动入列

**Independent Test**: XFO 页/跨源页/SPA/_blank 四类夹具（quickstart 场景 7-10）

### Tests for User Story 4

- [x] T049 [US4] 写失败单测：嵌入失败检测（load/onerror 启发式 + Tier2 心跳超时）tests/unit/embed-detection.test.ts
- [x] T050 [P] [US4] 写失败单测：frame 上报消息处理（URL 归属校验、SPA navKind、归属外丢弃）tests/unit/frame-report.test.ts
- [x] T051 [US4] 写失败 E2E：quickstart 场景 7-10 tests/e2e/navigation.spec.ts（以 scripts/verify-t059.ts 自带服务生命周期等效覆盖：Playwright Test 的 webServer 会启动常驻进程，与服务纪律冲突）

### Implementation for User Story 4

- [x] T052 [US4] 实现嵌入失败检测 src/sidebar/views/browser-view.ts（使 T049 通过，FR-006）
- [x] T053 [US4] 实现降级覆盖层（重试/当前标签页/新标签页/返回主页，不渲染外部 HTML）src/sidebar/views/fallback-overlay.ts（FR-006/FR-034）
- [x] T054 [US4] 实现 frame 上报 content script src/content/frame-reporter.ts（URL/标题/popstate/history 挂钩 + _blank/window.open 意图上报，runtime-messages.md）
- [x] T055 [US4] Spike：验证 Firefox scripting.registerContentScripts 注入扩展页 iframe scripts/spike-content-script.ts（research R3 遗留验证，结果写入 research.md）
- [x] T056 [US4] 实现授权后动态 content script 注册/注销 src/adapters/content-scripts.ts（contracts/manifest-permissions.md）
- [x] T057 [US4] 后台接线 frame.report 与 frame.open-request 处理 src/background/index.ts（使 T050 通过，FR-020/FR-023）
- [x] T058 [US4] 实现导航新来源自动入列 src/sidebar/state/site-registry.ts（addedBy=navigation，不覆盖用户入口，FR-019）
- [x] T059 [US4] 实现不确定态 UI（「可能未同步」地址/标题态）src/sidebar/components/nav-bar.ts 与 status-badge.ts（FR-021，使 T051 通过）

**Checkpoint**: US4 独立可用，iframe 边界全部有降级

---

## Phase 7: User Story 5 - 重启后恢复浏览会话 (Priority: P5)

**Goal**: 完整恢复标签/活动标签/设置/历史；损坏记录粒度丢弃；存储失败可降级提示；零敏感数据持久化

**Independent Test**: 多标签多历史重启恢复 + 损坏数据 + 存储检查（quickstart 场景 11、15）

### Tests for User Story 5

- [x] T060 [US5] 写失败单测：完整会话恢复（活动标签、历史位置、站点设置、全关后回主页）tests/unit/session-restore.test.ts
- [x] T061 [P] [US5] 写失败单测：损坏数据粒度丢弃（坏标签/坏历史/坏来源不影响其余）tests/unit/session-corruption.test.ts
- [x] T062 [US5] 写失败 E2E：重启恢复 + 存储中无敏感数据 tests/e2e/session.spec.ts（以 scripts/verify-t066.ts 等效覆盖，理由同 T051）

### Implementation for User Story 5

- [x] T063 [US5] 补全恢复路径 src/shared/session-store.ts 与 src/sidebar/app.ts（使 T060 通过，FR-017/FR-018）
- [x] T064 [US5] 实现逐条校验与粒度丢弃 src/shared/session-store.ts（使 T061 通过，FR-031）
- [x] T065 [US5] 实现存储失败重试 + session.dirty 推送 + 顶部警示条 src/shared/session-store.ts 与 src/sidebar/views/notice-bar.ts（FR-032，使 T062 通过）
- [x] T066 [US5] 手动检查点：quickstart 场景 11 与 15

**Checkpoint**: US5 独立可用，恢复语义完整

---

## Phase 8: User Story 6 - 使用紧凑且可访问的侧栏操作 (Priority: P6)

**Goal**: 紧凑标签栏 + 溢出标签列表；四类上下文悬停菜单；鼠标/触摸/键盘三通道 + ARIA

**Independent Test**: 窄侧栏 20 标签下鼠标/触摸/仅键盘各操作一遍（quickstart 场景 13-14）

### Tests for User Story 6

- [x] T067 [US6] 写失败单测：悬停菜单状态机（hover 延迟/触摸切换/聚焦打开/Esc/外部点击关闭、单实例）tests/unit/hover-menu.test.ts
- [x] T068 [US6] 写失败 E2E：菜单三通道操作 + 20 标签页压力 tests/e2e/ui.spec.ts（以 scripts/verify-t073.ts 等效覆盖，理由同 T051）

### Implementation for User Story 6

- [x] T069 [US6] 实现可访问悬停菜单组件 src/sidebar/components/hover-menu.ts（ARIA menu 模式，使 T067 通过，FR-027/FR-028）
- [x] T070 [US6] 实现紧凑标签栏与溢出标签列表 src/sidebar/components/tab-bar.ts（FR-024）
- [x] T071 [US6] 接线四类上下文菜单（标签/导航/网站/站点设置）src/sidebar/app.ts（contracts/ui-states.md，FR-026）
- [x] T072 [US6] 可访问性整改：aria-label、焦点环、键盘走查 src/sidebar/index.html 与各组件（FR-028，使 T068 通过）
- [x] T073 [US6] 手动检查点：quickstart 场景 13-14

**Checkpoint**: 六个故事全部独立可用

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: 跨故事验收与收尾

- [x] T074 全量自动化：npm run typecheck && npm test && npm run test:e2e && npm run build 全绿，修复残留失败
- [x] T075 Firefox 验收：`web-ext lint dist/firefox` 零 error/warning/notice；平台差异（DNR 权限声明方式、Tier 2 注入实测 ineffective）已记录到 research.md R3/R5。**桌面手动逐项勾选未执行**（需人工操作权限对话框），列为待办
- [x] T076 更新 AGENTS.md 的 AUTO:BUILD（真实命令）与 AUTO:STRUCTURE（实际目录）两区
- [x] T077 写入项目内存：关键架构决策（双层追踪模型/UA 策略/Cookie 策略/权限模型）至 project/decisions
- [x] T078 五轴终审（正确性/可读性/架构/安全/性能）：独立审查发现 12 条 [必须修复]（含 resize 死循环、授权状态双份真相、宪法 VII 违规 7 处等），已全部修复并补测试；契约文档同步修订 4 份

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖，立即开始
- **Foundational (Phase 2)**: 依赖 Setup — 阻断所有用户故事
- **US1 (Phase 3)**: 依赖 Foundational — MVP，最高优先
- **US2 (Phase 4)**: 依赖 Foundational + US1 视图存在
- **US3 (Phase 5)**: 依赖 Foundational + US2 权限适配与设置 UI（可与 US2 后半并行）
- **US4 (Phase 6)**: 依赖 US1 浏览视图 + US2/US3 授权流（Tier 2 复用授权）
- **US5 (Phase 7)**: 依赖 US1 持久化基础
- **US6 (Phase 8)**: 依赖 US1~US4 的界面元素存在
- **Polish (Phase 9)**: 依赖全部故事完成

### Within Each User Story

- 测试任务先写并确认失败，再实现（RED→GREEN）
- 状态/模型 → 适配层 → 后台接线 → UI → 检查点
- 每个故事完成其 Checkpoint 后再进入下一优先级

### Parallel Opportunities

- T003/T004/T005、T007/T008 可并行（不同文件）
- T012+T013、T014+T015 与 T010+T011 可并行（不同模块）
- 各故事内标记 [P] 的测试任务可并行编写
- US3（T042-T044）与 US2 后半（T037-T040）可由不同执行者并行

---

## Parallel Example: User Story 1

```bash
# 并行编写 US1 的两个独立单测：
Task: "写失败单测：网站注册表 tests/unit/site-registry.test.ts"
Task: "写失败单测：标签会话管理 tests/unit/tab-session.test.ts"

# 并行实现两个独立状态模块：
Task: "实现网站注册表 src/sidebar/state/site-registry.ts"
Task: "实现标签会话管理 src/sidebar/state/tab-session.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. 完成 Phase 1 Setup + Phase 2 Foundational
2. 完成 Phase 3 US1
3. **STOP**：quickstart 场景 1-3 验证 → 可用的最小侧栏浏览器

### Incremental Delivery

1. Setup + Foundational → 基座就绪
2. US1 → 验证 → MVP（添加/标签/恢复）
3. US2 → 验证 → 移动适配 + UA 授权
4. US3 → 验证 → 登录复用授权
5. US4 → 验证 → iframe 边界降级完整
6. US5 → 验证 → 会话恢复完整
7. US6 → 验证 → 交互与可访问性完整
8. Polish → 双端验收与终审

---

## Notes

- [P] = 不同文件、无依赖；[US*] 标签对应 spec.md 用户故事优先级
- 每个实现任务前先确认对应测试失败（宪法 II）
- 两个 spike（T036/T055）是 research.md 遗留验证项，失败仅收窄 Tier 2 能力面，不阻塞 Tier 1
- 提交节奏：每个任务或逻辑组一次原子提交（宪法 IV）
- 任一检查点可暂停并独立验证该故事
