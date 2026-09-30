// sidebarmobile — 权限外部撤销监听（background）
// 2026-09-29 | Kimi(speckit-fix) | 终审 [建议修改]：capabilities.changed 无生产者，接线补齐

import { originKeyFromUrl, originKeyToString } from '../shared/origin-key.ts';

/**
 * [DONE] 监听浏览器侧的权限撤销，驱动 `capabilities.changed` 推送（FR-030）。
 *
 * **为什么必须有这条通道**：用户在浏览器设置里撤销某个站点的权限时，扩展收不到任何消息。
 * 若只靠"下次查询时复核"，侧栏会一直显示旧状态 —— 徽章说「真实移动 UA」，而规则早已失效。
 * 这正是 FR-029「不得把降级显示为成功」要防的事。`permissions.onRemoved` 是浏览器给出的
 * 唯一通知渠道，此前无人订阅，于是契约里声明的 `capabilities.changed` 从来没有生产者。
 *
 * 监听注册在后台：它是常驻上下文，而侧栏可能根本没打开（此时无需推送，也无处推送）。
 */

/** 权限 API 的最小面：只需要撤销通知 */
export interface PermissionsWatchApiLike {
  onRemoved?: {
    addListener(listener: (removed: { permissions?: string[]; origins?: string[] }) => void): void;
  };
}

export interface PermissionWatchDeps {
  /** permissions 命名空间；undefined 表示该环境没有该 API（不订阅） */
  permissions: PermissionsWatchApiLike | undefined;
  /** 有来源被撤销时调用：后台据此现算状态并推送 */
  onOriginsRevoked(originKeys: string[]): void;
}

/**
 * [DONE] 把 host 权限 pattern 折回精确来源键。
 *
 * pattern 形如 `https://example.com/*`、`https://example.com:8443/*`。去掉路径部分后
 * 复用 `origin-key.ts` 的解析，从而与全项目其余地方的来源键规则完全一致
 * （手写解析会在端口归一化上漂移，导致推送的来源键与实际设置对不上）。
 *
 * 非法或非 http(s) 返回 null，由调用方丢弃。
 */
export function originKeyFromPattern(pattern: string): string | null {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return null;
  }
  // 只截掉路径：pattern 的 `/*` 是通配路径，来源部分在它之前
  const wildcardIndex = pattern.indexOf('/*');
  const originPart = wildcardIndex >= 0 ? pattern.slice(0, wildcardIndex) : pattern;
  const parsed = originKeyFromUrl(originPart);
  return parsed === null ? null : originKeyToString(parsed);
}

/**
 * [DONE] 订阅权限撤销通知。
 *
 * 只关心 **origins** 中被撤销的来源：API 权限（cookies / scripting / DNR）是全局的，
 * 撤销它会一次性影响所有已授权来源 —— 那种情况下浏览器也会同时撤销各来源的 host 权限，
 * 因此按 origins 逐一推送即可覆盖。
 *
 * 只有确实解析出至少一个来源键时才回调：把空数组推给上层会让它做一次无意义的现算。
 */
export function watchPermissionRemovals(deps: PermissionWatchDeps): void {
  const onRemoved = deps.permissions?.onRemoved;
  if (onRemoved === undefined || typeof onRemoved.addListener !== 'function') {
    return;
  }

  onRemoved.addListener((removed) => {
    const origins = removed.origins ?? [];
    const originKeys: string[] = [];
    for (const pattern of origins) {
      const originKey = originKeyFromPattern(pattern);
      // 非法 pattern 直接丢弃：它不可能对应到我们存过的任何来源
      if (originKey !== null && !originKeys.includes(originKey)) {
        originKeys.push(originKey);
      }
    }
    if (originKeys.length > 0) {
      deps.onOriginsRevoked(originKeys);
    }
  });
}
