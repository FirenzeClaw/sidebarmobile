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
├── .specify/                  # speckit 脚手架（templates / memory / scripts）
├── .kimi-code/skills/         # speckit-* 技能（由 specify init 安装）
├── .codegraph/                # 代码索引数据库
├── skills/                    # 预留
└── [待补充：源码目录，业务代码尚未创建]
```

源码目录结构待第一个功能落地时补充（预期形态：`src/` 放 TS 源码，分 background / content / sidebar 等入口，`public/` 或 `src/manifest.json` 放扩展清单，构建产物目录勿手工编辑）。
<!-- /AUTO:STRUCTURE -->

<!-- AUTO:BUILD -->
## 构建与运行

- 安装：`[待补充]`（尚无 `package.json`，包管理器与依赖未定）
- 运行：`[待补充]`
- 测试：`[待补充]`
- Lint / 类型检查：`[待补充]`

> 以上命令必须在项目内真实可运行后才写入此处。当前项目仅有启动引导产物，无构建配置 —— **禁止臆测命令名**，待脚手架建立后由 `project-init` 更新本区。
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
