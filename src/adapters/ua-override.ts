// sidebarmobile — UA 改写适配（adapters）
// 2026-09-29 | Kimi(speckit-implement) | T037：按 T036 spike 结论实现 DNR 会话规则路径（FR-007/FR-010）

import { originKeyFromUrl, originKeyToString } from '../shared/origin-key.ts';

/**
 * [DONE] 真实移动 User-Agent 的改写通道（research R5 + T036 实测结论）。
 *
 * **T036 spike 判定：DNR `modifyHeaders.set User-Agent` 对扩展页内 iframe 的子框架请求生效**
 * （Chrome for Testing 153 实测，证据见 `.playwright-mcp/t036/report.json` 与 research.md R5 补记）。
 * 因此本模块实现真实 DNR 路径，而不是固定降级。
 *
 * spike 还实测到一条对实现有决定影响的细节：**可选权限未授予时 `chrome.declarativeNetRequest`
 * 整个命名空间不存在**（不是"存在但调用报错"）。因此能力探测把"API 缺失"与"规则注册失败"
 * 分开判定 —— 前者 `unsupported`，后者 `degraded`。两者用户可见含义不同（FR-029 要求区分）。
 *
 * 规则设计（照用 spike 验证过的条件组合，contracts/manifest-permissions.md）：
 *   condition: { requestDomains: [该来源 hostname], resourceTypes: ['sub_frame'] }
 *   action:    { type: 'modifyHeaders', requestHeaders: [{ header: 'user-agent', operation: 'set', value }] }
 *
 * 契约：`apply`/`clear` **绝不抛异常**，全部失败路径返回结构化结果，由能力状态如实呈现。
 */

/**
 * 移动 User-Agent 模板。
 *
 * 取值的取舍：用 Android Chrome 的稳定模板而不是最新版本号 —— 站点侧对 UA 版本的适配通常是
 * "识别到移动设备即给移动版面"，把版本号钉在较新的固定值比随浏览器漂移更可预测。
 * 这不影响"是否为真实移动 UA"的判定（不是视口模拟，是真的改了请求头）。
 */
export const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

/** DNR 规则 id 规划：规则 id 由来源键哈希稳定推导，因此无需持久化映射（见 deriveRuleId） */
const RULE_ID_BASE = 10_000;
const RULE_ID_RANGE = 50_000;

/** 规则应用结果：applied 为 false 时 mode 说明实际退回到什么状态 */
export interface UaApplyResult {
  applied: boolean;
  /** real-ua = 请求头已改写；viewport = 退回移动视口 */
  mode: 'real-ua' | 'viewport';
  /** 失败原因分类，供能力状态映射（applied 为 true 时缺省） */
  reason?: 'unsupported' | 'rejected' | 'invalid-origin';
}

/** DNR 最小面：只声明本项目实际调用的方法，便于注入替身与跨浏览器兼容 */
export interface DnrSessionRuleApi {
  updateSessionRules(options: {
    removeRuleIds?: number[];
    addRules?: unknown[];
  }): Promise<void>;
  getSessionRules?(): Promise<Array<{ id: number }>>;
}

export interface UaOverrideOptions {
  /** DNR API；undefined 表示该环境不具备此能力 */
  dnr: DnrSessionRuleApi | undefined;
  /** 实际使用的移动 UA；测试可注入以便断言 */
  mobileUserAgent?: string;
}

export interface UaOverridePort {
  /**
   * 该来源当前是否已应用真实 UA 规则（终审 A4：以 DNR 会话规则实况为准）。
   *
   * 异步：规则是否还在只能问 DNR API。会话规则存活于整个浏览器会话，比 Service Worker
   * 生命周期长得多，因此它是**唯一**能跨 SW 回收仍然成立的事实来源。
   * 查询不可用（老浏览器没有 `getSessionRules`）时回落到本实例内存。
   */
  isApplied(originKey: string): Promise<boolean>;
  /**
   * 开启/关闭该来源的真实 UA 改写。
   *
   * `enabled = true` 注册会话规则；`false` 注销。任何失败都不抛异常。
   */
  apply(originKey: string, enabled: boolean, userAgent?: string): Promise<UaApplyResult>;
  /** 注销全部来源的规则（撤销授权、扩展卸载前的清理） */
  clearAll(): Promise<void>;
  /** 由来源键稳定推导规则 id；非法来源返回 null */
  ruleIdFor(originKey: string): number | null;
}

/**
 * [DONE] 由来源键稳定推导 DNR 规则 id。
 *
 * 用字符串哈希而不是自增计数器：规则 id 必须在 Service Worker 重启后仍能由 sites:v1 重建出
 * 同一组 id，否则重启会残留孤儿规则（旧规则不生效但占用配额）。哈希到固定区间后，
 * 同一来源永远得到同一 id，重启后 `removeRuleIds` 也能精确命中。
 */
export function deriveRuleId(originKey: string): number | null {
  if (originKeyFromUrl(originKey) === null) {
    return null;
  }
  let hash = 0;
  for (let index = 0; index < originKey.length; index += 1) {
    hash = (hash * 31 + originKey.charCodeAt(index)) % RULE_ID_RANGE;
  }
  // 加基数避开与未来可能引入的其他规则 id 空间相撞
  return RULE_ID_BASE + hash;
}

/**
 * [DONE] 由来源键生成 host 权限 pattern。
 *
 * 与 `permissions.ts` 的同名能力保持单一实现，避免两处 pattern 生成规则漂移
 * （pattern 不一致会导致"权限申请了但规则不生效"这类难查问题）。
 *
 * 来源键的序列化复用 `originKeyToString`（终审 [建议修改] DRY）：这里曾自己拼
 * `scheme://host:port`，与 origin-key.ts 重复 —— 端口归一化规则一旦改动，
 * 两处会给出不同的 pattern，而症状是"授权的站点规则不生效"。
 */
export function originPatternFromOriginKey(originKeyText: string): string | null {
  const parsed = originKeyFromUrl(originKeyText);
  if (parsed === null) {
    return null;
  }
  return `${originKeyToString(parsed)}/*`;
}

/** [DONE] 从来源键取 hostname（DNR `requestDomains` 不含端口） */
function hostnameFromOriginKey(originKeyText: string): string | null {
  const parsed = originKeyFromUrl(originKeyText);
  return parsed === null ? null : parsed.host;
}

/** [DONE] 创建 UA 改写端口；所有失败路径返回结构化结果 */
export function createUaOverride(options: UaOverrideOptions): UaOverridePort {
  const mobileUserAgent = options.mobileUserAgent ?? MOBILE_USER_AGENT;
  /**
   * 已成功应用规则的来源集合 —— 仅作为**缓存**（终审 A4）。
   *
   * 它不能作为判据：后台每条消息都新建实例，这个 Set 随之清空，于是"已生效"被漏报成
   * "已降级"。真正的判据是 DNR 会话规则实况（见 `isApplied`）。
   */
  const appliedOrigins = new Set<string>();

  /** [DONE] 该环境是否具备 DNR 会话规则能力（spike：权限未授予时整个 API 都不存在） */
  function isDnrAvailable(): boolean {
    return options.dnr !== undefined && typeof options.dnr.updateSessionRules === 'function';
  }

  /**
   * [DONE] 该来源的规则此刻是否真的在会话里。
   *
   * 查询不可用（DNR 缺失、或没有 `getSessionRules`）时回落到本地缓存 —— 这是唯一的
   * 次优选择，且方向安全：缓存里没有就返回 false，宁可少报成功也不谎报 active。
   * 查询本身抛错同样回落：探测失败不等于"规则不在"，但也不能据此声称规则在。
   */
  async function isRuleLive(originKey: string): Promise<boolean> {
    const ruleId = deriveRuleId(originKey);
    if (ruleId === null) {
      return false;
    }
    const getSessionRules = options.dnr?.getSessionRules;
    if (typeof getSessionRules !== 'function') {
      return appliedOrigins.has(originKey);
    }
    try {
      const rules = await getSessionRules.call(options.dnr);
      const live = rules.some((rule) => rule.id === ruleId);
      // 校准缓存：既把丢失的规则摘掉，也把仍然在的补上，避免下次回落时用过时信息
      if (live) {
        appliedOrigins.add(originKey);
      } else {
        appliedOrigins.delete(originKey);
      }
      return live;
    } catch {
      return appliedOrigins.has(originKey);
    }
  }

  return {
    isApplied(originKey: string): Promise<boolean> {
      return isRuleLive(originKey);
    },

    ruleIdFor(originKey: string): number | null {
      return deriveRuleId(originKey);
    },

    async apply(originKey: string, enabled: boolean, userAgent?: string): Promise<UaApplyResult> {
      const ruleId = deriveRuleId(originKey);
      const hostname = hostnameFromOriginKey(originKey);
      if (ruleId === null || hostname === null) {
        return { applied: false, mode: 'viewport', reason: 'invalid-origin' };
      }

      if (!enabled) {
        // 关闭路径：即使 DNR 不可用也必须把本地标记清掉，否则 UI 会继续声称已生效
        appliedOrigins.delete(originKey);
        if (!isDnrAvailable()) {
          return { applied: false, mode: 'viewport', reason: 'unsupported' };
        }
        try {
          await options.dnr!.updateSessionRules({ removeRuleIds: [ruleId] });
          return { applied: false, mode: 'viewport' };
        } catch {
          return { applied: false, mode: 'viewport', reason: 'rejected' };
        }
      }

      if (!isDnrAvailable()) {
        return { applied: false, mode: 'viewport', reason: 'unsupported' };
      }

      try {
        await options.dnr!.updateSessionRules({
          removeRuleIds: [ruleId],
          addRules: [
            {
              id: ruleId,
              priority: 1,
              action: {
                type: 'modifyHeaders',
                requestHeaders: [
                  { header: 'user-agent', operation: 'set', value: userAgent ?? mobileUserAgent },
                ],
              },
              // 条件组合来自 T036 spike 的实测通过项，勿随意增删
              condition: { requestDomains: [hostname], resourceTypes: ['sub_frame'] },
            },
          ],
        });
        appliedOrigins.add(originKey);
        return { applied: true, mode: 'real-ua' };
      } catch {
        // 规则被拒绝（权限不足、pattern 不匹配、浏览器内部限制）：如实降级，不谎报成功
        appliedOrigins.delete(originKey);
        return { applied: false, mode: 'viewport', reason: 'rejected' };
      }
    },

    async clearAll(): Promise<void> {
      const ruleIds = [...appliedOrigins]
        .map((originKey) => deriveRuleId(originKey))
        .filter((id): id is number => id !== null);
      appliedOrigins.clear();
      if (!isDnrAvailable() || ruleIds.length === 0) {
        return;
      }
      try {
        await options.dnr!.updateSessionRules({ removeRuleIds: ruleIds });
      } catch {
        // 清理失败不阻断流程：孤儿规则不再被引用，且下次同来源 apply 会先 remove 同 id 再添加
      }
    },
  };
}
