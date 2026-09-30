// sidebarmobile — 授权流测试辅助（测试辅助）
// 2026-09-30 | Kimi(fix) | 用户实测反馈：授权申请与落地拆为两段后，测试需复刻生产的调用顺序

import {
  createPermissionsPort,
  type PermissionsApiLike,
  type PermissionsPort,
} from '../../src/adapters/permissions.ts';
import { createGrantCoordinator, type GrantCoordinator, type GrantOutcome } from '../../src/background/grant-coordinator.ts';
import type { CookieInsightPort } from '../../src/adapters/cookie-insight.ts';
import type { UaOverridePort } from '../../src/adapters/ua-override.ts';
import { permissionSpecFor } from '../../src/shared/permission-spec.ts';
import type { GrantKind } from '../../src/shared/messages.ts';
import type { SiteSettings } from '../../src/shared/types.ts';

/**
 * [DONE] 既有授权规则测试用的协调器：把「侧栏申请权限」这一段接回来。
 *
 * 背景：`permissions.request` 已从后台移到侧栏（用户实测缺陷的修复 —— 该 API 必须在用户手势
 * 的直接调用链内执行），后台只保留**复核与落地**。于是"一次授权"在生产上是两段：
 *
 *   侧栏：permissions.request(spec)  →  后台：applyGrantOutcome(..., 结论)
 *
 * 既有测试关心的是授权**规则**（标记怎么变、能力怎么算、撤销是否连带），不是手势链本身
 * （后者由 `tests/unit/grant-gesture-chain.test.ts` 单独锁定）。因此本辅助提供一个绑定包装，
 * 让那些测试继续用 `requestGrant(...)` 表达"用户批准了这次授权"，而底层走的仍是生产的两段路径。
 *
 * **不做的事**：不替调用方决定结论。包装内部真的去申请权限，并把浏览器的原生返回值交给后台 ——
 * 若这里直接传 `'granted'`，测试就跳过了"权限是否真的到手"这一环，那正是本次要锁定的东西。
 */
export interface GrantChainCoordinator extends GrantCoordinator {
  /** 走完整生产路径：申请权限（侧栏职责）→ 复核落地（后台职责） */
  requestGrant(originKey: string, grant: GrantKind, currentSettings: SiteSettings): Promise<GrantOutcome>;
}

/** [DONE] 把一段权限端口接到协调器的复核路径上 */
export function withGrantChain(
  coordinator: GrantCoordinator,
  permissions: PermissionsPort,
): GrantChainCoordinator {
  return {
    ...coordinator,
    async requestGrant(
      originKey: string,
      grant: GrantKind,
      currentSettings: SiteSettings,
    ): Promise<GrantOutcome> {
      const reported = await permissions.request(permissionSpecFor(originKey, grant));
      return coordinator.applyGrantOutcome(originKey, grant, reported, currentSettings);
    },
  };
}

export interface ChainCoordinatorOptions {
  /** 权限 API 替身；undefined 表示该环境没有 permissions API */
  permissionsApi: PermissionsApiLike | undefined;
  uaOverride: UaOverridePort;
  cookieInsight?: CookieInsightPort;
}

/**
 * [DONE] 装配一个走完整生产路径的协调器。
 *
 * 同一个权限端口同时用于"申请"与协调器的"复核"：用两个不同替身会造出
 * "申请写入 A、复核读 B"的假象 —— 测试看似通过而生产不成立。
 */
export function createChainCoordinator(options: ChainCoordinatorOptions): GrantChainCoordinator {
  const permissions = createPermissionsPort(options.permissionsApi);
  const coordinator = createGrantCoordinator({
    permissions,
    uaOverride: options.uaOverride,
    ...(options.cookieInsight === undefined ? {} : { cookieInsight: options.cookieInsight }),
  });
  return withGrantChain(coordinator, permissions);
}
