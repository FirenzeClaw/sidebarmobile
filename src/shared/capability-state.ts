// sidebarmobile — 能力状态计算（shared）
// 2026-09-29 | Kimi(speckit-implement) | T034：实现以通过 T031（FR-029，data-model §6）
// 2026-09-29 | Kimi(speckit-fix) | 终审 [建议修改]：从 sidebar/state 移到 shared（后台与侧栏共用）

import type {
  CapabilityState,
  CookieCapabilityState,
  EmbedCapabilityState,
  GrantState,
  NavigationCapabilityState,
  UaCapabilityState,
} from './types.ts';

/**
 * [DONE] 运行时能力状态的现算规则（**不持久化**，data-model §6）。
 *
 * 这是 FR-029「不得将降级结果显示为成功」的唯一裁决点：UI 只消费本模块的输出，
 * 不允许自行推断"应该能用了吧"。三条映射原则：
 *
 * 1. **未授权优先**：grant 不是 granted，或权限已被外部撤销 → `unauthorized`。
 *    外部撤销后即使标记还留着 granted，也必须在下次计算时回归未授权（FR-030）。
 * 2. **不支持 ≠ 失败**：浏览器没有该 API → `unsupported`；API 在但规则注册失败 → `degraded`。
 *    两者用户可见含义完全不同（换浏览器 vs 该站点降级），不得合并。
 * 3. **未探测 ≠ 成功**：没有探测结果时给 `unknown`，绝不默认 assumed-OK。
 *
 * 真实 UA 是否生效的唯一证据是 DNR 规则应用结果（T036 spike 已实测该路径有效）；
 * 移动视口本身**永远不**把 ua 标成 active —— 视口只是 CSS 层面的适配，不是真实 UA。
 */

/** UA 能力的计算输入：授权标记 + 权限复核 + 规则应用结果 */
export interface UaCapabilityInput {
  grant: GrantState;
  /** `permissions.contains` 复核结果；未授权时无意义 */
  permissionHeld: boolean;
  /** 浏览器是否具备该 API（DNR modifyHeaders）。undefined 视为具备，由规则结果兜底 */
  ruleSupported?: boolean;
  /** 规则应用结果；null = 尚未尝试（未授权或未探测） */
  ruleApplied: boolean | null;
}

/** Cookie 能力的计算输入：授权标记 + 权限复核 + 探测结果 */
export interface CookieCapabilityInput {
  grant: GrantState;
  permissionHeld: boolean;
  /** cookies API 是否存在；undefined 视为存在 */
  apiSupported?: boolean;
  /**
   * 探测本身出错（API 在但调用失败）与 API 不存在是两种不同的受限原因：
   * 前者界面说「加载失败」（可能是暂时故障），后者说「能力受限」（环境不支持）。
   */
  probeFailed?: boolean;
  /**
   * 会话存在性探测结论（终审 B2）：true = 检测到 Cookie，false = 没检测到。
   *
   * `undefined` = **未探测**（未授权、或授权方没注入探测能力）→ 只能说 `available`，
   * 不得声称"已检测到会话"。这一区分是 B2 的修法核心：把"没探测过"与"探测过且没有"
   * 分开，两者界面说法不同。
   */
  sessionPresent?: boolean;
}

export interface CapabilityStateInput {
  ua?: UaCapabilityInput;
  cookie?: CookieCapabilityInput;
  navigation?: NavigationCapabilityState;
  embed?: EmbedCapabilityState;
}

/** [DONE] UA 能力映射 */
export function mapUaCapability(input: UaCapabilityInput): UaCapabilityState {
  // 优先级 1：未授权（含外部撤销后权限复核失败）
  if (input.grant !== 'granted' || !input.permissionHeld) {
    return 'unauthorized';
  }
  // 优先级 2：浏览器根本不具备该能力
  if (input.ruleSupported === false) {
    return 'unsupported';
  }
  // 优先级 3：尚未尝试应用规则 → 不猜，如实说未知
  if (input.ruleApplied === null || input.ruleApplied === undefined) {
    return 'unknown';
  }
  // 优先级 4：已授权、浏览器支持，但规则没落地 → 降级（继续用移动视口）
  return input.ruleApplied ? 'active' : 'degraded';
}

/** [DONE] Cookie 能力映射（US3 只做存在性检测语义，见 research R6） */
export function mapCookieCapability(input: CookieCapabilityInput): CookieCapabilityState {
  if (input.grant !== 'granted' || !input.permissionHeld) {
    return 'unauthorized';
  }
  // 探测出错：能力暂时不可用，如实说失败而不是"可用"
  if (input.probeFailed === true) {
    return 'failed';
  }
  // 授权了但 cookies API 不可用：能力受限，而非未授权
  if (input.apiSupported === false) {
    return 'limited';
  }
  // 探测过且没有会话：能力可用但结论是"未检测到"，不能与"已检测到"共用一档（终审 B2）
  if (input.sessionPresent === false) {
    return 'absent';
  }
  return 'available';
}

/**
 * [DONE] 组装完整能力状态。
 *
 * 默认值刻意保守：UA/Cookie 未授权、导航不确定（Tier 1 只能观察到"发生了导航"）、
 * 嵌入未知（未观察前不声称可嵌入）。这样任何遗漏都会表现为"说得比实际更不确定"，
 * 而不是"把降级说成成功"。
 */
export function createCapabilityState(input: CapabilityStateInput = {}): CapabilityState {
  return {
    ua: mapUaCapability(input.ua ?? { grant: 'never', permissionHeld: false, ruleApplied: null }),
    cookie: mapCookieCapability(input.cookie ?? { grant: 'never', permissionHeld: false }),
    navigation: input.navigation ?? 'uncertain',
    embed: input.embed ?? 'unknown',
  };
}
