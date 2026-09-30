// sidebarmobile — 权限适配（adapters）
// 2026-09-29 | Kimi(speckit-implement) | T035：实现以通过 T032（FR-010/FR-013/FR-030/FR-035）
// 2026-09-30 | Kimi(fix) | 用户实测反馈：注明 request 必须在侧栏手势链内调用（后台只做复核/撤销）

import { OPTIONAL_PERMISSION_NAMES, type OptionalPermissionName } from '../shared/permission-names.ts';

/**
 * [DONE] 可选权限的申请 / 复核 / 撤销（宪法 III 权限最小化，research R7）。
 *
 * 三条不可让步的语义：
 *
 * 1. **只申请用户显式开启的能力**：本模块不主动申请任何权限，调用方必须在用户操作开关时才调用
 *    `request`（spec FR-035）。
 * 2. **失败不是异常**：用户拒绝、浏览器不支持、API 抛错都是**正常降级路径**，必须返回分类结果
 *    让 UI 如实显示（spec FR-036：拒绝授权后仍可添加网址、浏览、用移动视口）。
 *    因此本模块的每个方法都不抛异常。
 * 3. **复核保守**：`contains` 在 API 不可用或抛错时返回 false —— 宁可显示"未授权"也不能谎报持有，
 *    否则外部撤销后会继续声称能力可用（spec FR-030）。
 *
 * 关于权限名的类型：`browser-api.ts` 已把可选权限名收敛为字面量联合，本模块沿用该联合，
 * 防止适配层被传入未在清单声明的权限名。
 */

/** 一次权限操作的三种结局 */
export type PermissionOutcome = 'granted' | 'denied' | 'unsupported';

/** 撤销的三种结局（granted 不适用） */
export type RemoveOutcome = 'removed' | 'unsupported';

export interface PermissionRequestSpec {
  /** 项目声明过的可选权限；留空表示只申请来源权限 */
  permissions: readonly OptionalPermissionName[];
  /** host 权限 pattern，如 `https://example.com/*`；留空表示只申请 API 权限 */
  origins: readonly string[];
}

/**
 * 权限端口：对 `browser-api.ts` 的最小投影。
 *
 * 为什么要投影而不是直接用 `permissionsApi`：单测需要注入替身来模拟"用户拒绝""API 抛错"
 * "API 不存在"三种现实中都会发生但难以在真实浏览器里稳定复现的情况。投影接口与
 * `permissionsApi` 结构兼容，生产代码直接传它即可（见 `createAppPermissionsPort`）。
 *
 * **`request` 的使用位置有硬性约束**（2026-09-30 用户实测缺陷）：它必须在**用户手势的
 * 直接调用链**内被调用，因此生产环境里只有侧栏的 `sidebar/state/grant-request.ts` 会调它；
 * 后台只调 `contains` / `remove`。绕道后台（或先 await 一条消息再申请）会让 Chromium
 * 抛出「This function must be called during a user gesture」，用户看到的是开关点不动。
 * 这条约束由 `tests/unit/grant-gesture-chain.test.ts` 锁定。
 */
export interface PermissionsPort {
  request(spec: PermissionRequestSpec): Promise<PermissionOutcome>;
  contains(spec: PermissionRequestSpec): Promise<boolean>;
  remove(spec: PermissionRequestSpec): Promise<RemoveOutcome>;
}

/** 生产环境注入点：`browser-api.ts` 的 permissionsApi 满足本接口 */
export interface PermissionsApiLike {
  request(spec: { permissions?: readonly string[]; origins?: readonly string[] }): Promise<boolean>;
  contains(spec: { permissions?: readonly string[]; origins?: readonly string[] }): Promise<boolean>;
  remove(spec: { permissions?: readonly string[]; origins?: readonly string[] }): Promise<boolean>;
}

/**
 * [DONE] 创建权限端口。
 *
 * `api` 为 undefined 表示该浏览器环境没有 permissions API（如某些非扩展页上下文），
 * 此时所有操作返回 unsupported —— 这是能力探测的一部分，不是错误。
 */
export function createPermissionsPort(api: PermissionsApiLike | undefined): PermissionsPort {
  /** [DONE] 过滤出项目声明过的权限名，防止传入未声明的权限 */
  function sanitize(spec: PermissionRequestSpec): { permissions: OptionalPermissionName[]; origins: string[] } {
    const declared = new Set<string>(OPTIONAL_PERMISSION_NAMES);
    return {
      permissions: spec.permissions.filter((name) => declared.has(name)),
      origins: [...spec.origins],
    };
  }

  return {
    async request(spec: PermissionRequestSpec): Promise<PermissionOutcome> {
      if (api === undefined || typeof api.request !== 'function') {
        return 'unsupported';
      }
      try {
        const granted = await api.request(sanitize(spec));
        return granted ? 'granted' : 'denied';
      } catch {
        // API 抛错（清单未声明该可选权限、来源 pattern 非法、浏览器内部错误）：
        // 归为 denied 而非 unsupported —— 用户视角都是"这次没能开启"，且必须能回弹降级
        return 'denied';
      }
    },

    async contains(spec: PermissionRequestSpec): Promise<boolean> {
      if (api === undefined || typeof api.contains !== 'function') {
        return false;
      }
      try {
        return await api.contains(sanitize(spec));
      } catch {
        return false;
      }
    },

    async remove(spec: PermissionRequestSpec): Promise<RemoveOutcome> {
      if (api === undefined || typeof api.remove !== 'function') {
        return 'unsupported';
      }
      try {
        await api.remove(sanitize(spec));
        // 撤销的返回值语义在各浏览器不一致（部分实现返回是否成功撤销），因此不据此判定，
        // 统一回 'removed' 由调用方用 contains 复核（spec FR-013 即时撤销后必须复核）
        return 'removed';
      } catch {
        return 'unsupported';
      }
    },
  };
}

/** [DONE] 生产环境端口：直接对接 browser-api 适配出口 */
export async function createAppPermissionsPort(): Promise<PermissionsPort> {
  // 动态导入：browser-api 会拉起 webextension-polyfill，只在扩展运行时需要它，
  // 静态导入会让权限适配层的单测在 Node 下直接失败
  const { permissionsApi } = await import('./browser-api.ts');
  return createPermissionsPort(permissionsApi);
}

/**
 * 来源 pattern 的生成与匹配在 `ua-override.ts` 中实现（`originPatternFromOriginKey`）。
 *
 * 这里不做二次实现，也不在此重新导出：pattern 生成规则一旦在两处漂移，会出现
 * 「权限申请成功了但 DNR 规则不生效」这类极难定位的问题，因此全项目只有一处 pattern 生成。
 */
