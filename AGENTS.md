# sidebarmobile — AGENTS.md

<!-- AUTO:PROJECT-META -->
## 项目元信息

- 项目：sidebarmobile
- 技术栈：浏览器扩展（侧栏 UI）· Chrome MV3 + Firefox 双端兼容 · TypeScript + 打包器 · webextension-polyfill
- 类型：浏览器扩展（Side Panel / Sidebar）
- 初始化日期：2026-09-29
<!-- /AUTO:PROJECT-META -->

<!-- AUTO:STRUCTURE -->
## 目录结构

```
sidebarmobile/
├── AGENTS.md                  # 本文件，项目级 AI 上下文
├── src/
│   ├── background/            # 后台（SW/事件页）：消息路由、授权协调、frame 上报处理
│   │                          # permission-watch（外部撤销监听）
│   ├── sidebar/               # 侧栏 UI
│   │   ├── app.ts             # 装配层（视图切换、菜单接线、会话恢复）
│   │   ├── index.html         # 侧栏页骨架
│   │   ├── state/             # 纯逻辑状态：标签会话、网站注册表、站点设置、frame 归属
│   │   ├── views/             # 视图：网站列表、网页浏览、降级覆盖层
│   │   ├── components/        # 组件：导航条、弹层、悬停菜单、标签列表、徽章、图标
│   │   └── styles/            # themes.css（六主题 token）+ app.css（消费变量）
│   ├── content/               # content script（Tier 2 追踪：URL/标题/新窗上报）
│   ├── adapters/              # 浏览器 API 出口：browser-api / permissions / ua-override
│   │                          # cookie-insight / content-scripts
│   ├── shared/                # 跨场景共用：url-policy / origin-key / messages
│   │                          # session-store / types / permission-names
│   │                          # capability-state / frame-report-spec（后台与侧栏共用）
│   ├── manifests/             # 双端清单模板（构建期分流）
│   └── icons/                 # 扩展图标（由 scripts/generate-icons.ts 生成）
├── scripts/                   # build / fixture-server / generate-icons
│                             # verify-t029|t041|t048|t059|t066|t073（真实浏览器检查点）
│                             # spike-dnr-ua / spike-content-script
├── tests/
│   ├── unit/                  # 纯逻辑单测
│   ├── integration/           # 授权流、持久化等集成测试
│   └── helpers/               # mock-browser（API 替身）、fixture-lifecycle（服务生命周期）
├── demo/                      # 已审查通过的交互原型（设计基线活样例，非产品代码）
├── design-system/MASTER.md    # 设计基线（六主题 token、布局锁定项、组件规格）
├── specs/                     # speckit 规格产物（spec/plan/research/data-model/contracts/tasks）
├── dist/                      # 构建产物（chrome/ 与 firefox/），勿手工编辑
├── .specify/                  # speckit 脚手架
├── .kimi-code/skills/         # speckit-* 技能
└── .codegraph/                # 代码索引数据库
```

分层约定：`app.ts` 是唯一装配层；`state/` 与 `shared/` 为纯逻辑（可单测、不碰 DOM）；仅 `adapters/` 可触达浏览器 API（宪法 VII）。
<!-- /AUTO:STRUCTURE -->

<!-- AUTO:BUILD -->
## 构建与运行

- 安装：`npm install`
- 类型检查：`npm run typecheck`（tsc --noEmit，必须零错误）
- 单元/集成测试：`npm test`（Vitest，当前 529 项）
- 构建双端：`npm run build`（产物 `dist/chrome/`、`dist/firefox/`）
- 夹具站点：`npm run fixtures`（六类测试页面，端口 8919）
- Firefox 运行：`npm run run:firefox`（web-ext run --source-dir=dist/firefox）
- Firefox 清单校验：`npx web-ext lint --source-dir dist/firefox`
- 真实浏览器检查点（自带夹具服务，端口 8921，跑完自动清理端口）：

  ```bash
  node --experimental-strip-types scripts/verify-t029.ts   # US1 添加与标签浏览（40 项）
  node --experimental-strip-types scripts/verify-t041.ts   # US2 移动视口与 UA 授权（27 项）
  node --experimental-strip-types scripts/verify-t048.ts   # US3 登录复用授权（18 项）
  node --experimental-strip-types scripts/verify-t059.ts   # US4 嵌入降级与追踪（21 项）
  node --experimental-strip-types scripts/verify-t066.ts   # US5 会话恢复（27 项）
  node --experimental-strip-types scripts/verify-t073.ts   # US6 菜单三通道与压力（28 项）
  ```

- 手动加载：Chrome `chrome://extensions` → 开发者模式 → 加载已解压 → `dist/chrome`；Firefox `about:debugging` → 临时载入附加组件 → `dist/firefox/manifest.json`

> 约束：验证脚本必须自带夹具服务生命周期（端口 8921）并在结束时释放端口与浏览器进程；禁止以后台常驻方式启动服务。
<!-- /AUTO:BUILD -->

## 工具优先级

1. **代码结构理解优先用 codegraph**（`codegraph_explore` / `codegraph_search` / `codegraph_node`），不可用时降级为 grep/glob/Read
2. **会话开始先读项目内存**：`memory_get(namespace="project/meta")` 与 `memory_get(namespace="project/decisions")`，只读不写；新的架构决策由负责编排的会话写入
3. 文件操作用专用工具（Read/Write/Edit/Glob/Grep），不滥用 shell

<!-- AUTO:CONVENTIONS -->
## 编码约定

### 命名

- 函数：动宾结构（`fetchUserById`、`isValidEmail`）
- 变量：名词短语（`activeUserCount`），禁缩写、禁 1-2 字符名
- 组件 PascalCase，工具函数 camelCase，常量 UPPER_SNAKE_CASE

### 控制流

- Guard clauses 优先，嵌套 ≤3 层
- 复杂条件提取为布尔变量
- 函数超过 50 行考虑拆分；magic number 改为命名常量

### 注释

注释的核心原则：**代码说 how，注释说 why**。注释不是代码的翻译，而是代码无法自解释的决策、约束和上下文。

#### 文件头（必须）

每个 `.ts` / `.tsx` 文件前两行为文件头注释，后续修改只追加不删除：

```ts
// sidebarmobile — [模块名]（[场景: background/content/sidebar/shared]）
// YYYY-MM-DD | 操作者(工具) | 变更摘要
```

#### 功能标注（必须）

所有函数/类/模块使用标准标记反映完成状态：

| 标记 | 含义 | 示例 |
|------|------|------|
| `[DONE]` | 已实现并通过验收 | `/** [DONE] 用户登录 */` |
| `[WIP]` | 开发中，未完成 | `// [WIP] 待接入消息缓存` |
| `[WORKAROUND]` | 临时方案，需后续替换 | `// [WORKAROUND] 绕过兼容性问题` |
| `[STUB]` | 占位实现 | `/** [STUB] 待实现 */` |
| `[UNCERTAIN]` | 行为不确定，待验证 | `// [UNCERTAIN] 并发场景下是否幂等` |

#### 注释语言

- **注释使用中文**，标识符保留英文
- 模块级 docstring（JSDoc `@module`）：说明模块职责 + 所属场景 + 关键入口函数一览
- 函数 JSDoc：参数/返回值/副作用/异常，复杂逻辑加算法说明
- 消息/API 端点 docstring：对应 spec 需求编号（如 `§FR-01`）

#### 必须加注释的位置（强制）

1. **每次外部 API 调用** — 说明调用目的、失败影响
2. **复杂条件分支（≥3 个条件）** — 说明业务含义和每种走向的后果
3. **业务规则/公式** — 计算逻辑引用 spec 编号
4. **查询/筛选的过滤条件** — 说明为啥排除这些项
5. **任何硬编码常量/UUID** — 必须标 `[WORKAROUND]` 并说明替换计划
6. **任何 `pass`/`return undefined` 的非空函数** — 说明为什么当前不实现
7. **任何与项目设计原则相关的决策** — 引用原则编号

#### Spec 交叉引用格式

```ts
// 工作流节点推进（spec §PF-04 流程引擎）
// 企业查重（spec §CS-01 + 原则 3 场景不割裂）
```

#### 禁止事项

- ❌ 注释写 what（代码本身已经说明的）
- ❌ inline 注释（行尾 `// ...`），改为独立注释行
- ❌ TODO 注释（待办进 issue 或任务列表）
- ❌ 删除代码时直接删掉而不注释（改为注释 + 日期 + 原因，确保 git 可追溯）

#### 变更记录块

当一段代码从 A 改为 B 时，用注释记录变更历史而非直接覆盖：

```ts
// [WORKAROUND] YYYY-MM-DD 原因说明
// 原始: oldMethod()
// 替换为:
newMethod()
```

### 类型与不可变

- 显式标注函数签名；禁止 `any` / 非必要 `as`
- 更新对象/数组用不可变方式（spread），禁止直接 mutate

### 错误处理

- 每个外部调用必须有错误处理并给出有意义的错误信息
- 第三方响应不可信，边界处必须校验

### 浏览器扩展专项

- **权限最小化**：manifest 只申请实际用到的 `permissions` / `host_permissions`，新增权限须在评审中说明理由
- **双端 API 差异**：统一走 `webextension-polyfill` 的 `browser.*`（Promise 风格），禁止在业务代码里直接分支 `chrome.*` / `browser.*`
- **MV3 约束**：Service Worker 无常驻状态，禁止依赖全局变量做跨事件持久化；改用 `browser.storage`
- **消息传递**：`runtime.sendMessage` 的收发两端必须校验消息形状，不信任发送方
- **内容脚本隔离**：不向页面注入未净化的字符串，禁止 `innerHTML` 处理页面/用户数据
- **清单一致性**：`manifest.json` 的版本号与发布包保持一致，双端差异用构建产物区分而非运行时判断

### API 设计（如适用）

- 资源名复数 + kebab-case，URL 无动词；列表必须分页
- 统一错误格式 `{ "error": { "code", "message", "details" } }`；500 永不暴露内部细节
- 只增不改：新字段必须 optional，禁止删除字段或改类型
<!-- /AUTO:CONVENTIONS -->

## Git 约定

- 提交格式：`<type>: <描述>`，type ∈ `feat`/`fix`/`refactor`/`test`/`docs`/`chore`，消息解释 why
- 原子提交：一次提交只做一件逻辑完整的事；理想 ~100 行，~300 可接受，~1000 必须拆分
- 格式化与逻辑、重构与功能分开提交
- 分支：`feature/` `fix/` `chore/` `refactor/` 前缀，短命分支（1-3 天），main 始终可部署
- 提交前：`git diff --staged` 自查 → 查密钥（password/secret/api_key/token）→ 跑测试

## 安全红线

- 边界校验所有外部输入；查询全部参数化
- 输出编码防 XSS，不绕过框架自动转义；禁止 `eval` / `new Function` 处理不可信数据
- 密钥管理：禁止提交密钥（含 `.kimi-code/` 内的凭据类文件，已列入 `.gitignore` 提示）；禁止在日志记录敏感数据
- 禁止向用户暴露堆栈信息
- 外部通信一律 HTTPS

## 质量门

- 没有失败的测试就不写生产代码（TDD 铁律）
- 不审查不合并：五轴审查（正确性/可读性/架构/安全/性能），三级标注（[必须修复]/[建议修改]/[仅供参考]）
- 详细原则见 `.specify/memory/constitution.md`
