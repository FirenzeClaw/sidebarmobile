// sidebarmobile — 授权标记与能力状态的同步（sidebar）
// 2026-09-30 | Kimi(fix) | 用户实测缺陷修复：从 app.ts 抽出为纯逻辑，使规则可被真实测试

import type { CapabilityState } from '../../shared/types.ts';

/**
 * [DONE] 把后台复核后的能力状态同步成侧栏的授权标记。
 *
 * **为什么抽成独立模块**：这条规则此前是 `app.ts` 的内部函数，只能靠"复刻一份等价实现"
 * 来测试 —— 而复刻测的是复刻本身，测不出真实实现的缺陷。用户实测的
 * 「弹窗出现、点允许后无效」正是这样漏过 590 项测试的。抽出来后测试直接调用真实实现。
 *
 * **开关与徽章是两件事**（区分它们才能修对）：
 * - 开关 = 用户是否授权（复核通过即开）；
 * - 徽章 = 该能力当前生效到什么程度（active / degraded / available / absent / limited …）。
 *
 * 因此**凡复核通过的状态都要把开关置为已授权**，包括 `degraded`（授权到手但规则没落地）
 * 与 `limited`（授权到手但能力受限）—— 那时开关理应开着，由徽章如实说明降级。
 * 若只在 `active` 时升格，授权到手但规则落地延迟时开关会弹回，用户以为"点了不允许"。
 *
 * 授权标记的唯一真相是后台复核结果：侧栏只按它对齐，不自行推断（它没有复核权限的手段，
 * 契约要求不信任发送方）。降级保持原语义：外部撤销或复核失败后标记回到 `revoked`（FR-030）。
 */

/** 本模块只需要设置读写这两件事，便于测试注入与复用 */
export interface GrantSyncTarget {
  getGrant(originKey: string, kind: 'ua' | 'cookie'): 'never' | 'granted' | 'revoked';
  setGrant(originKey: string, kind: 'ua' | 'cookie', state: 'never' | 'granted' | 'revoked'): boolean;
}

/**
 * [DONE] 按复核结论同步两项授权标记。
 *
 * 返回被改动的项（供调用方决定是否重绘/持久化）；无改动返回空数组。
 */
export function syncGrantsFromReview(
  target: GrantSyncTarget,
  originKey: string,
  state: CapabilityState,
): Array<'ua' | 'cookie'> {
  const changed: Array<'ua' | 'cookie'> = [];

  /** UA：active（规则生效）与 degraded（授权到手但规则未落地）都表示复核通过 */
  const uaGrantedByReview = state.ua === 'active' || state.ua === 'degraded';
  if (uaGrantedByReview) {
    if (target.getGrant(originKey, 'ua') !== 'granted') {
      target.setGrant(originKey, 'ua', 'granted');
      changed.push('ua');
    }
  } else if (state.ua === 'unauthorized' && target.getGrant(originKey, 'ua') === 'granted') {
    target.setGrant(originKey, 'ua', 'revoked');
    changed.push('ua');
  }

  /** Cookie：available / absent / limited 都表示复核通过，差别只在能力生效程度 */
  const cookieGrantedByReview =
    state.cookie === 'available' || state.cookie === 'absent' || state.cookie === 'limited';
  if (cookieGrantedByReview) {
    if (target.getGrant(originKey, 'cookie') !== 'granted') {
      target.setGrant(originKey, 'cookie', 'granted');
      changed.push('cookie');
    }
  } else if (state.cookie === 'unauthorized' && target.getGrant(originKey, 'cookie') === 'granted') {
    target.setGrant(originKey, 'cookie', 'revoked');
    changed.push('cookie');
  }

  return changed;
}
