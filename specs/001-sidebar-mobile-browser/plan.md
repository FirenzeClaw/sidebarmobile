# Implementation Plan: 侧栏移动浏览器

**Branch**: `001-sidebar-mobile-browser` | **Date**: 2026-09-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-sidebar-mobile-browser/spec.md`

## Summary

构建纯客户端双端浏览器扩展：侧栏内以 iframe 为核心的小型移动浏览器，支持多标签页、网站列表（按精确来源归并）、移动视口默认 + 按需授权的真实移动 UA 与登录复用（均为最佳努力、状态如实呈现）、完整会话持久化恢复，以及鼠标/触摸/键盘三通道的悬停图标子菜单。技术路线：TypeScript + esbuild + webextension-polyfill，双 manifest 构建期分流，Vitest 单测 + Playwright（Chromium）E2E + web-ext（Firefox）验收。关键架构修正（研究 R3）：`webNavigation` 不覆盖扩展页内 iframe，导航追踪采用「load 事件（Tier 1）+ 授权后 content script 上报（Tier 2）」双层模型。

## Technical Context

**Language/Version**: TypeScript 5.x（strict）/ Node 24（本机 nvm）

**Primary Dependencies**: webextension-polyfill（API 统一）、esbuild（打包）、Vitest（单测/集成）、Playwright（真实浏览器检查点）、web-ext（Firefox 运行与清单校验）

**Storage**: `browser.storage.local`（键 `session:v1` / `sites:v1` / `meta:v1`，见 [contracts/storage-schema.md](contracts/storage-schema.md)）

**Testing**: Vitest（单元/集成，529 项）+ 六个真实浏览器检查点脚本（Playwright 持久化上下文加载未打包扩展，自带夹具服务生命周期，合计 161 项断言）+ `web-ext lint` 清单校验（[quickstart.md](quickstart.md)）

**Target Platform**: Chrome MV3（`sidePanel`）+ Firefox MV3（`sidebar_action`，≥128 — `optional_host_permissions` 与 `data_collection_permissions` 所需）

**Project Type**: browser-extension（侧栏 UI）

**Performance Goals**: 常规操作 2 秒内给出反馈或加载态（SC-008）；20 标签页流畅操作（SC-003）；每标签历史 ≤100 条

**Constraints**: MV3 Service Worker 无常驻状态（持久化全走 storage）；不引入服务器/代理；可选权限按需申请；存储预算 <1MB（远低于 5MB 最小配额）；禁止 innerHTML/eval 处理外部数据；Cookie 遵循浏览器规则（无端口级隔离）

**Scale/Scope**: 单扩展仓库，约 8 个源码模块 + 2 份 manifest 模板 + 3 层测试；40 条功能需求全部纳入首版

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 门 | 结果 |
|------|-----|------|
| I 简单性优先 | 无服务器/代理/框架；esbuild 显式配置；vanilla TS 视图 | PASS |
| II 测试先行 | 测试三层定义于 quickstart；tasks 将按 RED→GREEN 排序，每个 FR 先有失败测试 | PASS |
| III 安全无例外 | 基础权限仅 `storage`(+`sidePanel`)；敏感能力全部可选权限按精确来源申请；消息两端校验（contracts/runtime-messages）；外部数据禁 innerHTML；Cookie 值不读不写不存 | PASS |
| IV 原子提交 | 实施切片按用户故事划分，每片独立可提交 | PASS |
| V 不审查不合并 | 每片完成后五轴审查再进入下一片 | PASS |
| VI 可读性与显式契约 | 消息/存储/清单/UI 四份契约先于实现冻结 | PASS |
| VII 双端不靠运行时分支 | 清单/后台注册差异构建期分流；能力差异在适配层以能力探测收敛，业务代码无浏览器分支 | PASS |

**实现后复核（2026-09-29 终审）**: 终审发现 7 处 `browser.*` 直用（background/content 绕过适配层），违反宪法 VII，已全部改为经 `adapters/browser-api.ts` 出口；`capability-state` 从 `sidebar/state` 移到 `shared/`（后台曾反向依赖 sidebar）。两处修正均已补测试锁定。

**Post-Phase-1 复核**: 设计产物（research/data-model/contracts/quickstart）未引入新复杂度；双层追踪模型（R3）是浏览器 API 边界的最小应对，Tier 1 无权限要求、Tier 2 复用已有授权，不构成宪法违规。无 Complexity Tracking 条目。

## Project Structure

### Documentation (this feature)

```text
specs/001-sidebar-mobile-browser/
├── plan.md              # 本文件
├── spec.md              # 功能规格
├── research.md          # Phase 0：10 项技术决定
├── data-model.md        # Phase 1：实体/校验/状态机
├── quickstart.md        # Phase 1：端到端验收指南
├── checklists/
│   └── requirements.md  # 规格质量清单（已全绿）
├── contracts/
│   ├── runtime-messages.md      # 运行时消息协议
│   ├── storage-schema.md        # 存储结构与容量预算
│   ├── manifest-permissions.md  # 双端清单与权限策略
│   └── ui-states.md             # 视图/菜单/状态徽章契约
└── tasks.md             # Phase 2（/skill:speckit-tasks 生成）
```

### Source Code (repository root)

```text
src/
├── background/
│   └── index.ts              # SW 入口：权限/规则/消息路由
├── sidebar/
│   ├── index.html            # 面板页（双端共用）
│   ├── app.ts                # 视图切换与装配
│   ├── views/                # 网站列表 / 网页浏览 / 降级层
│   └── components/           # 紧凑标签栏 / 悬停菜单 / 状态徽章
├── content/
│   └── frame-reporter.ts     # Tier 2：URL/标题/新窗上报
├── adapters/
│   ├── browser-api.ts        # polyfill 统一出口
│   ├── permissions.ts        # 按需申请/撤销/复核
│   ├── ua-override.ts        # DNR 规则（Firefox 回退 webRequest）
│   ├── cookie-insight.ts     # Cookie 存在性检测（不读值）
│   └── tabs-external.ts      # 普通标签页打开
├── shared/
│   ├── url-policy.ts         # http/https 校验与规范化
│   ├── origin-key.ts         # 精确来源键
│   ├── messages.ts           # 消息协议类型与校验
│   ├── session-store.ts      # storage 读写/防抖/坏记录丢弃
│   └── types.ts              # 数据模型类型
└── manifests/
    ├── manifest.chrome.json  # 构建输入
    └── manifest.firefox.json # 构建输入

tests/
├── unit/                     # 纯逻辑单测（URL/来源键/消息/会话/状态机/菜单/视图）
├── integration/              # 授权流/持久化/上报归属（mock browser + mock storage）
└── helpers/                  # mock-browser（API 替身）、dom-stub、fixture-lifecycle（服务生命周期）

scripts/
├── build.ts                  # esbuild 多入口 + manifest 分流 + 静态资源拷贝
├── fixture-server.ts         # 夹具站点（可嵌入/XFO/CSP/登录态/跨源/SPA/新窗口）
├── generate-icons.ts         # 占位图标（正式图标属设计交付物）
├── spike-dnr-ua.ts           # 实测 DNR 改写 User-Agent 是否生效
├── spike-content-script.ts   # 实测 Firefox content script 注入行为
└── verify-t029|t041|t048|t059|t066|t073.ts  # 六个真实浏览器检查点（自带服务生命周期）
```

**Structure Decision**: 单仓库单扩展。`shared/` 与 `adapters/` 保证 UI 不直接触达浏览器 API（宪法 III/VII）；`sidebar` / `background` / `content` 三入口对应扩展运行三上下文；manifest 双份构建期生成，产物 `dist/chrome` 与 `dist/firefox` 即发布包。测试为「Vitest 单元/集成 + 真实浏览器检查点脚本」两层：不使用 Playwright Test 的 `webServer` 常驻服务，改由检查点脚本自带夹具生命周期（详见 quickstart.md）。

## Complexity Tracking

> 无宪法违规，无需条目。
