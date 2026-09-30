// sidebarmobile — 侧栏授权申请（sidebar）
// 2026-09-30 | Kimi(fix) | 用户实测反馈：权限申请移入侧栏，在用户手势的直接调用链内执行

import { permissionSpecFor } from '../../shared/permission-spec.ts';
import type { CapabilityState } from '../../shared/types.ts';
import type { GrantKind } from '../../shared/messages.ts';
import type { PermissionOutcome, PermissionsPort } from '../../adapters/permissions.ts';

/**
 * [DONE] 授权申请的用户手势链（宪法 III 权限最小化 + Chrome 硬性约束）。
 *
 * **为什么放在侧栏而不是后台**：`permissions.request()` 必须在用户手势的**直接调用链**中
 * 执行。浏览器对手势的判定不看"源头是用户点击"，只看调用栈与时间窗 ——
 * 侧栏点击 → 消息 → 后台申请，中间的跨进程消息往返会让手势失效，Chromium 于是**直接拒绝**
 * 并抛出「This function must be called during a user gesture」（Chromium 153 实测，见
 * `scripts/verify-grant-real.ts`）；该错误经适配层映射为 denied，用户看到的现象就是
 * "开关点不动、也不弹权限对话框" —— 因为申请从未真正发起过裁决。
 *
 * 因此本模块的调用约定（两条都不可让步）：
 *
 * 1. **`permissions.request` 必须是点击后的第一个 await**。手势活性有时间窗，
 *    先 await 一条消息、一次状态查询再申请，就等于把缺陷原样搬回来 ——
 *    调用点虽然在侧栏，行为却和放在后台一样。
 * 2. **先拿浏览器结论，再通知后台落地**。后台负责写授权标记、注册/注销 DNR 规则与
 *    content script，这些是"授权之后"的副作用，必须在权限确实到手（或确实被拒）之后执行。
 *    颠倒顺序会在权限对话框还开着时就落规则 —— 用户随后点了拒绝，规则却已经生效。
 *
 * 本模块**不判定**授权是否成立：它只把浏览器的原生结论原样上抛。判定属于后台的复核
 * （`permissions.contains`），因为侧栏是不可信发送方（contracts/runtime-messages.md）。
 */

/** 后台落地响应的形状；与 `messages.ts` 的信封一致，形状不符时由调用方回落降级 */
export interface GrantResponseShape {
  granted: boolean;
  reason?: 'denied' | 'unsupported';
  state: CapabilityState;
}

/** 通知后台落地的载荷：**只带结论**，不带权限规格（规格由后台用同一实现自行推导） */
export interface GrantApplyRequest {
  originKey: string;
  grant: GrantKind;
  /** 浏览器给出的原生结论 */
  outcome: PermissionOutcome;
}

/** 调用链依赖：端口与后台通道都可注入（单测用替身锁定调用时序） */
export interface GrantGestureDeps {
  /** 权限端口（生产环境由侧栏经 `adapters/permissions.ts` 对接 browser-api 出口） */
  permissions: PermissionsPort;
  /** 通知后台执行授权后的副作用；后台不可达时返回 null */
  sendApply(request: GrantApplyRequest): Promise<GrantResponseShape | null>;
}

/**
 * [DONE] 在手势链内申请授权并通知后台落地。
 *
 * 返回 null 表示后台不可达（或响应形状不符），调用方按既有降级路径处理 ——
 * 这与修复前 `sendGrantMessage` 返回 null 的语义完全一致，界面表现不变。
 */
export async function requestGrantInGestureChain(
  deps: GrantGestureDeps,
  originKey: string,
  grant: GrantKind,
): Promise<GrantResponseShape | null> {
  /**
   * 手势链内**第一个** await：不得在此之前插入任何异步操作。
   *
   * `permissionSpecFor` 是纯同步计算（无 I/O），放在这里不消耗手势时间窗。
   */
  const outcome = await deps.permissions.request(permissionSpecFor(originKey, grant));

  /**
   * 权限结论已定，此后才轮到后台的副作用。
   *
   * 无论 granted/denied/unsupported 都要通知后台：三种结局对**授权标记**的语义各不相同
   * （granted → granted，denied → revoked，unsupported → never），
   * 而这些标记只有后台在复核后才知道该怎么写。侧栏不代它决定。
   */
  return deps.sendApply({ originKey, grant, outcome });
}
