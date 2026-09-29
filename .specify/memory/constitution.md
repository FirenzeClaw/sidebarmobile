# sidebarmobile 项目宪法

<!--
Sync Impact Report
- Version: 0.0.0 → 1.0.0 (initial ratification)
- Principles: I 简单性优先 / II 测试先行 / III 安全无例外 / IV 原子提交与主干开发 / V 不审查不合并 / VI 可读性与显式契约
- Instantiated: 2026-09-29，由 project-bootstrap 从模板填充（技术栈：Chrome MV3 + Firefox 双端兼容的侧栏扩展，TypeScript + 打包器）
- Follow-ups: 随项目演进按 Governance 修订；修订由 speckit-constitution 接管
-->

**CONSTITUTION_VERSION**: 1.0.0
**RATIFICATION_DATE**: 2026-09-29
**LAST_AMENDED_DATE**: 2026-09-29

## I. 简单性优先

- 能用就行的最简单方案优先；易懂 > 聪明（KISS）
- 公共逻辑只存在一处，禁止复制粘贴编程（DRY）
- 不提前构建不需要的功能，只在必要时增加复杂度（YAGNI）
- 理由：复杂度是负债，未验证的需求大概率会变

## II. 测试先行

- **没有失败的测试就不写生产代码**，无例外
- 循环：先写必然失败的测试并实际看到它失败（RED）→ 写刚好够通过的最少代码（GREEN）→ 绿灯后重构，不加新行为（REFACTOR）
- 修 bug 必须先写重现 bug 的失败测试（Prove-It）
- 跑测试用仓库自己的命令，不默认 `npm test` 之类的臆测
- 理由：后写测试验证的是"这做了什么"，先写测试定义的是"这应该做什么"

## III. 安全无例外

- 边界处校验所有外部输入；查询全部参数化；输出编码防 XSS
- 密钥哈希存储；会话凭据必须 httpOnly + secure + sameSite（如项目引入服务端）
- 禁止：提交密钥、记录敏感日志、信任客户端校验、用 `eval`/`innerHTML` 处理用户数据、向用户暴露堆栈
- 新增认证流、敏感数据处理、外部集成、CORS 变更、文件上传，必须先获得人工批准
- **浏览器扩展专项**：manifest 权限最小化（新增 `permissions`/`host_permissions` 须评审说明）；消息传递两端校验消息形状；MV3 Service Worker 不依赖全局变量跨事件持久化，改用 `storage`
- 理由：安全缺陷的代价远高于流程成本

## IV. 原子提交与主干开发

- `main` 始终可部署；功能分支短命（1-3 天）；feature flag 优于长分支
- 一次提交做一件逻辑完整的事；提交消息解释 why；格式化/重构与功能变更分开提交
- 实现切片 → 测试 → 验证 → 提交 → 下一切片；禁止堆积后的巨型提交
- 理由：小步快走让回滚、审查、二分定位都保持廉价

## V. 不审查不合并

- 重要功能完成后、合并 main 前必须审查，不因"很简单"跳过
- 审查按五轴：正确性 → 可读性 → 架构 → 安全 → 性能
- 评论必标级别：[必须修复] 阻断合并；[建议修改] 需回应；[仅供参考] 不阻断
- bug fix 必须有回归测试；安全敏感变更必须过安全轴
- 理由：审查是最便宜的缺陷拦截点

## VI. 可读性与显式契约

- 代码被读多于被写：自文档化命名，注释只写 why
- 注释规范遵循 `AGENTS.md` §注释（文件头记录、功能标注、why not how、spec 交叉引用、变更记录块），代码审查时检查注释是否满足"7 项必须加注释的位置"
- 显式类型签名；禁止 `any` / 非必要断言
- 模块接口先定义契约再实现；一切可观察行为都是承诺（Hyrum's Law），设计时即规划废弃
- 理由：隐性契约是集成 bug 与破坏性变更的主要来源

## VII. 双端兼容不靠运行时分支

- Chrome MV3 与 Firefox 的差异在**构建/清单层**解决，禁止在业务代码里散布 `if (chrome) ... else ...`
- 浏览器 API 统一走 `webextension-polyfill` 的 `browser.*` Promise 风格
- 每个功能在两端的行为差异必须显式记录（README 或 spec），不允许"只在 Chrome 测过"就宣称完成
- 理由：运行时分支会让两端行为逐渐分叉且难以测试

## Governance

- 本宪法优先于其他所有项目惯例；冲突时以宪法为准
- 修订程序：提出修正案 → 说明理由 → 更新版本与 LAST_AMENDED_DATE → 同步检查依赖模板（AGENTS.md、spec/plan/tasks 模板）
- 版本策略（语义化）：MAJOR = 删除或重定义原则；MINOR = 新增原则或实质性扩充；PATCH = 措辞澄清
- 每个实施计划（plan）必须包含宪法合规检查；违反宪法的做法无论多"临时"都不允许
