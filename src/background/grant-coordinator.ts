// sidebarmobile — 授权协调（background）
// 2026-09-29 | Kimi(speckit-implement) | T038：按来源申请/撤销授权并现算能力状态（FR-010/FR-013/FR-029/FR-030）
// 2026-09-29 | Kimi(speckit-fix) | 终审 A3：revokeGrant 改逐权限名判断，避免关闭一项授权连带撤销另一项
// 2026-09-29 | Kimi(speckit-fix) | 终审 A4：UA 规则存活改以 API 实况判定（await isApplied）
// 2026-09-29 | Kimi(speckit-fix) | 终审 B2：Cookie 探测结论上抛 present/absent，供能力状态分档

import {
  createCapabilityState,
  mapUaCapability,
  type CookieCapabilityInput,
  type UaCapabilityInput,
} from '../shared/capability-state.ts';
import { createDefaultSiteSettings, type CapabilityState, type GrantState, type SiteSettings } from '../shared/types.ts';
import type { GrantKind } from '../shared/messages.ts';
import { apiPermissionForGrant, type OptionalPermissionName } from '../shared/permission-names.ts';
import type { PermissionsPort } from '../adapters/permissions.ts';
import { originPatternFromOriginKey, type UaOverridePort } from '../adapters/ua-override.ts';
import type { CookieInsightPort } from '../adapters/cookie-insight.ts';

/**
 * [DONE] 授权与能力状态的协调层。
 *
 * **无状态设计**：协调器不持有、也不持久化授权标记，标记由调用方（侧栏，持有 site-settings）
 * 传入并接收更新后的副本。这样做的理由：
 *
 * 1. MV3 的 Service Worker 无常驻状态，后台本来就无法可靠保存授权标记（宪法 III）；
 * 2. 授权标记只有**一个写入者**（侧栏的状态层），不会出现后台与侧栏各存一份而逐渐分叉；
 * 3. 纯输入→输出使 FR-010/FR-013/FR-030 三条规则可以被直接单测，不必启动浏览器。
 *
 * 协调器负责的只有"特权操作"：`permissions.request/remove` 与 DNR 规则注册/注销。
 */

/** 一次授权操作的结果：拒绝与不支持都是正常降级路径 */
export interface GrantOutcome {
  granted: boolean;
  /** granted 为 false 时的原因；供 UI 选择文案（拒绝 = 「未授权，已使用降级模式」） */
  reason?: 'denied' | 'unsupported';
  /** 更新后的设置副本；调用方据此写回自己的状态层 */
  settings: SiteSettings;
  /** 操作后的能力状态（已含 permissions.contains 复核） */
  state: CapabilityState;
}

export interface GrantCoordinatorOptions {
  permissions: PermissionsPort;
  uaOverride: UaOverridePort;
  /**
   * Cookie 存在性检测（US3）。
   *
   * 可选：US2 的调用方不需要它。传了才参与 Cookie 能力计算 —— 没传时 Cookie 能力只到
   * `available` / `unauthorized`，不会声称检测过会话。
   */
  cookieInsight?: CookieInsightPort;
}

export interface GrantCoordinator {
  /** 用户开启某来源的某项授权（FR-010：只在此时才申请权限） */
  requestGrant(originKey: string, grant: GrantKind, currentSettings: SiteSettings): Promise<GrantOutcome>;
  /** 用户关闭授权：立即撤权限 + 清标记 + 注销规则（FR-013） */
  revokeGrant(originKey: string, grant: GrantKind, currentSettings: SiteSettings): Promise<GrantOutcome>;
  /** 现算能力状态（含权限复核；外部撤销后自动回归未授权，FR-030） */
  queryCapabilities(originKey: string, currentSettings: SiteSettings): Promise<CapabilityState>;
}

/**
 * [DONE] 该来源在某项授权下需要申请的权限集合。
 *
 * 粒度是**精确来源**（host 权限 pattern 由 OriginKey 生成），且 UA 与 Cookie 申请互不相同的
 * API 权限 —— 两者严格分离，开一个不会顺带拿到另一个（spec FR-009/FR-011）。
 *
 * DNR 权限名按平台取（见 shared/permission-names.ts）：Chrome 与 Firefox 的可选权限名不同，
 * 这是构建期决定的事实，不需要在运行时判断浏览器。
 */
function permissionSpecFor(
  originKey: string,
  grant: GrantKind,
): { permissions: readonly OptionalPermissionName[]; origins: readonly string[] } {
  const pattern = originPatternFromOriginKey(originKey);
  const origins = pattern === null ? [] : [pattern];
  // Firefox 的 UA 授权只申请 host 权限（DNR API 权限随安装声明，见 permission-names.ts）
  return { permissions: apiPermissionForGrant(grant), origins };
}

/** [DONE] 创建无状态授权协调器 */
export function createGrantCoordinator(options: GrantCoordinatorOptions): GrantCoordinator {
  const { permissions, uaOverride, cookieInsight } = options;

  /**
   * [DONE] 现算能力状态。
   *
   * 顺序要紧：先 `contains` 复核，再据复核结果算状态。这样「标记还是 granted 但权限已被外部
   * 撤销」会算成 `unauthorized`，而不是继续声称 `active`（FR-030）。
   * 同时把标记修正为 `revoked`，让持久化的意愿与浏览器事实保持一致。
   */
  async function computeState(originKey: string, currentSettings: SiteSettings): Promise<CapabilityState> {
    const uaHeld = await permissions.contains(permissionSpecFor(originKey, 'ua'));
    const cookieHeld = await permissions.contains(permissionSpecFor(originKey, 'cookie'));

    const uaGrant = reconcileGrant(currentSettings.uaGrant, uaHeld);
    const cookieGrant = reconcileGrant(currentSettings.cookieGrant, cookieHeld);

    /**
     * 规则是否已落地：以 DNR 会话规则实况为准（终审 A4）。
     *
     * 不能读实例内存：后台每条消息都新建协调器与 ua-override，那条路径上内存永远是空的，
     * 会把"已生效"错报成 degraded（界面显示「已降级为移动视口」，而规则其实在跑）。
     */
    const uaInput: UaCapabilityInput =
      uaGrant === 'granted' && uaHeld
        ? { grant: uaGrant, permissionHeld: true, ruleApplied: await uaOverride.isApplied(originKey) }
        : { grant: uaGrant, permissionHeld: uaHeld, ruleApplied: null };

    return createCapabilityState({
      ua: uaInput,
      cookie: await buildCookieInput(originKey, cookieGrant, cookieHeld),
      // Tier 1：无 host 权限时只能观察到「发生了导航」，如实标不确定（FR-021）
      navigation: 'uncertain',
      embed: 'unknown',
    });
  }

  /**
   * [DONE] 组装 Cookie 能力输入，必要时做一次存在性探测。
   *
   * 只在「已授权且权限在手」时探测：未授权还去读 Cookie 属于无权限窥探，且必然失败。
   * 探测结果决定 `available`（API 正常）还是 `limited` / `failed` —— 三者界面说法不同，
   * 不能把「授权成功」等同于「能力可用」（spec FR-029）。
   *
   * 探测结果**只用后即弃**：不写入设置、不进入存储（FR-033 禁止持久化 Cookie 明细）。
   */
  async function buildCookieInput(
    originKey: string,
    cookieGrant: GrantState,
    cookieHeld: boolean,
  ): Promise<CookieCapabilityInput> {
    if (cookieGrant !== 'granted' || !cookieHeld) {
      return { grant: cookieGrant, permissionHeld: cookieHeld };
    }

    if (cookieInsight === undefined) {
      // 未注入探测能力（US2 调用方）：授权在手即视为可用，但不声称检测过会话
      return { grant: cookieGrant, permissionHeld: true };
    }

    const presence = await cookieInsight.detectSession(originKey);
    if (presence.status === 'unsupported' || presence.status === 'failed') {
      return {
        grant: cookieGrant,
        permissionHeld: true,
        apiSupported: false,
        probeFailed: presence.status === 'failed',
      };
    }

    /**
     * 存在性结论如实上抛（终审 B2）。
     *
     * 原先这里把 `present` 与 `absent` 一并丢弃、只回报「已授权且权限在」，导致两者都落到
     * `available`，界面于是对"没有会话"的站点声称「已检测到会话」。探测结果正是这里唯一的产出，
     * 丢掉它等于把这次探测白做。
     */
    return { grant: cookieGrant, permissionHeld: true, sessionPresent: presence.status === 'present' };
  }

  /** [DONE] 标记与事实不一致时以事实为准：授权过但权限没了 → revoked */
  function reconcileGrant(declared: GrantState, permissionHeld: boolean): GrantState {
    if (declared === 'granted' && !permissionHeld) {
      return 'revoked';
    }
    return declared;
  }

  /** [DONE] 把复核后的标记写回设置副本 */
  async function withReconciledSettings(
    originKey: string,
    currentSettings: SiteSettings,
  ): Promise<SiteSettings> {
    const uaHeld = await permissions.contains(permissionSpecFor(originKey, 'ua'));
    const cookieHeld = await permissions.contains(permissionSpecFor(originKey, 'cookie'));
    return {
      displayMode: currentSettings.displayMode,
      uaGrant: reconcileGrant(currentSettings.uaGrant, uaHeld),
      cookieGrant: reconcileGrant(currentSettings.cookieGrant, cookieHeld),
    };
  }

  return {
    async requestGrant(
      originKey: string,
      grant: GrantKind,
      currentSettings: SiteSettings,
    ): Promise<GrantOutcome> {
      const outcome = await permissions.request(permissionSpecFor(originKey, grant));

      // 先按事实修正标记，再叠加本次操作结果，避免旧的失效标记污染返回值
      const base = await withReconciledSettings(originKey, currentSettings);

      if (outcome !== 'granted') {
        /**
         * 拒绝与不支持的标记语义不同：
         * - 用户**拒绝**（denied）→ `revoked`：记录了"用户主动关过"，界面可以据此解释为何是关着的；
         * - 浏览器**不支持**（unsupported）→ `never`：这不是用户的选择，也不该被当作"关过的开关"，
         *   否则换到支持的浏览器后会出现一个来历不明的 revoked 标记。
         * 两种情况的**能力状态**都必须是 unauthorized —— 绝不留下一个"看起来开着"的开关（FR-029）。
         */
        const failureState = outcome === 'unsupported' ? 'never' : 'revoked';
        const failedSettings: SiteSettings = { ...base, ...grantPatch(grant, failureState) };
        return {
          granted: false,
          reason: outcome === 'unsupported' ? 'unsupported' : 'denied',
          settings: failedSettings,
          state: await computeState(originKey, failedSettings),
        };
      }

      const grantedSettings: SiteSettings = { ...base, ...grantPatch(grant, 'granted') };

      if (grant === 'ua') {
        // 权限到手后立刻尝试落规则；失败不改授权标记，由能力状态如实显示 degraded
        await uaOverride.apply(originKey, true);
      }

      return { granted: true, settings: grantedSettings, state: await computeState(originKey, grantedSettings) };
    },

    async revokeGrant(originKey: string, grant: GrantKind, currentSettings: SiteSettings): Promise<GrantOutcome> {
      const base = await withReconciledSettings(originKey, currentSettings);

      /**
       * 两项授权**共享**部分权限：同一个精确来源的 host 权限 pattern，以及 `scripting`
       * （Tier 2 注入前提，终审 A3 后由两者共同申请）。而 `permissions.remove` 是按名字整体移除的。
       *
       * 若无条件撤销，关掉 Cookie 会连带撤掉 UA 依赖的 host 权限与 scripting，
       * 用户会看到「关了一个开关，另一个跟着失效」——这是产品缺陷，不是浏览器限制。
       *
       * 因此逐个权限名判断：只有另一项授权不再需要它时才移除；本次授权**独占**的权限总是移除。
       * 逐名判断而不是"整体保留/整体移除"：两项授权的权限集合并不完全重合
       * （Cookie 有 cookies，UA 有 DNR），按集合整体处理会漏掉这些差异。
       */
      const otherKind: GrantKind = grant === 'ua' ? 'cookie' : 'ua';
      const otherGrantState = otherKind === 'ua' ? base.uaGrant : base.cookieGrant;
      const otherSpec = permissionSpecFor(originKey, otherKind);
      const otherStillGranted = otherGrantState === 'granted';

      const thisSpec = permissionSpecFor(originKey, grant);
      /** 另一项已授权时它保留的权限名（用于判断哪些不该移除） */
      const foreignNames = otherStillGranted ? new Set(otherSpec.permissions) : new Set<string>();
      /** 另一项已授权时它仍需的 host 权限 */
      const keepOrigins = otherStillGranted;

      await permissions.remove({
        permissions: thisSpec.permissions.filter((name) => !foreignNames.has(name)),
        origins: keepOrigins ? [] : thisSpec.origins,
      });

      const revokedSettings: SiteSettings = { ...base, ...grantPatch(grant, 'never') };

      if (grant === 'ua') {
        await uaOverride.apply(originKey, false);
      }

      return {
        granted: false,
        settings: revokedSettings,
        state: await computeState(originKey, revokedSettings),
      };
    },

    queryCapabilities(originKey: string, currentSettings: SiteSettings): Promise<CapabilityState> {
      return computeState(originKey, currentSettings);
    },
  };
}

/** [DONE] 生成只改一项授权标记的设置补丁 */
function grantPatch(kind: GrantKind, state: GrantState): Partial<SiteSettings> {
  return kind === 'ua' ? { uaGrant: state } : { cookieGrant: state };
}

/** [DONE] 空设置来源的默认值（协调器与测试共用） */
export function defaultSettings(): SiteSettings {
  return createDefaultSiteSettings();
}

/** [DONE] 供后台与侧栏共用的 UA 能力单点判定（避免两处各写一遍优先级） */
export { mapUaCapability };
