// sidebarmobile — 授权所需权限规格（shared）
// 2026-09-30 | Kimi(fix) | 用户实测反馈：权限申请移到侧栏后，申请与复核必须共用同一份规格推导

import { apiPermissionForGrant, type OptionalPermissionName } from './permission-names.ts';
import { originPatternFromOriginKey } from './origin-key.ts';
import type { GrantKind } from './messages.ts';

/**
 * [DONE] 某来源某项授权需要申请的权限集合。
 *
 * **单一实现**（DRY）：授权申请（侧栏，手势链内）与授权复核/撤销（后台）必须用同一份推导。
 * 两处各写一遍的后果是"申请成功的权限"与"复核时检查的权限"不是同一批 ——
 * 表现为用户明明点了允许，后台复核却说不通过（或反过来：复核放行了一个并未申请到的权限）。
 *
 * 粒度是**精确来源**（host 权限 pattern 由 OriginKey 生成），且 UA 与 Cookie 申请互不相同的
 * API 权限 —— 两者严格分离，开一个不会顺带拿到另一个（spec FR-009/FR-011）。
 *
 * DNR 权限名按平台取（见 `permission-names.ts`）：Chrome 与 Firefox 的可选权限名不同，
 * 这是**构建期**决定的事实，不需要在运行时判断浏览器（宪法 VII）。
 */

export interface PermissionSpec {
  permissions: readonly OptionalPermissionName[];
  origins: readonly string[];
}

/** [DONE] 推导某来源某项授权需要申请的权限集合 */
export function permissionSpecFor(originKey: string, grant: GrantKind): PermissionSpec {
  const pattern = originPatternFromOriginKey(originKey);
  const origins = pattern === null ? [] : [pattern];
  // Firefox 的 UA 授权只申请 host 权限（DNR API 权限随安装声明，见 permission-names.ts）
  return { permissions: apiPermissionForGrant(grant), origins };
}
